// rosefn single-binary server.
//
// Embeds the built site (dist/) into one static Go binary - no Node, no
// runtime dependencies, nothing to install on the target machine:
//
//	npm run build
//	go build -o rosefn-server .
//	PORT=8080 ./rosefn-server
//
// Static routes are served from the embedded prerendered HTML (one request
// per page load, client bundle inlined). Text files are answered in the
// brotli bytes `rosefn build` precompressed (dist/<file>.br) - zero
// per-request compression CPU - with weak ETags so repeat visits cost a
// bodiless 304. Unknown paths fall back to index.html: the boot script
// detects the route mismatch and client-renders the requested route, so
// dynamic routes work without a server round-trip.
//
// Ops (innovation #34): every request writes one access line to stdout,
// /metrics answers the Prometheus text format, and UPSTREAM=<url> turns the
// binary into the static half of a hybrid deploy - POSTs (server actions)
// and unbaked /api routes are reverse-proxied to the Node/edge backend.
package main

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed all:dist
var dist embed.FS

// The embedded FS is immutable, so every file is read and gzipped at most
// once: raw bytes and gzip bytes are both cached forever. Without this the
// server re-reads and re-gzips an ~11 KB document on every request - pure
// CPU burn and allocation churn for output that can never change.
// Brotli needs no cache at all: `rosefn build` writes dist/<file>.br next
// to every text file (innovation #28) and those exact bytes are served -
// zero per-request compression CPU, and the same wire size the Node server
// produces by compressing the file in memory.
var (
	fileCache sync.Map // name -> []byte (nil when missing)
	gzipCache sync.Map // name -> []byte
	etagCache sync.Map // name -> string
)

func readDist(name string) ([]byte, bool) {
	if v, ok := fileCache.Load(name); ok {
		b, ok := v.([]byte)
		return b, ok && b != nil
	}
	b, err := dist.ReadFile(name)
	if err != nil {
		fileCache.Store(name, nil)
		return nil, false
	}
	fileCache.Store(name, b)
	return b, true
}

func gzipBytes(body []byte) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	_, _ = gz.Write(body)
	_ = gz.Close()
	return buf.Bytes()
}

// etagOf is a weak validator over the raw bytes (FNV-1a, stdlib): identical
// bytes always yield an identical tag, so a repeat visit with a matching
// If-None-Match is answered by a bodiless 304 - on the Node server too,
// which validates its static files the same way.
func etagOf(body []byte) string {
	h := fnv.New32a()
	_, _ = h.Write(body)
	return fmt.Sprintf(`W/"%d-%x"`, len(body), h.Sum32())
}

func writeBody(w http.ResponseWriter, r *http.Request, name string, body []byte, encoding string, etag string) {
	h := w.Header()
	h.Set("Content-Type", mimeOf(name))
	h.Set("Cache-Control", "public, max-age=3600")
	h.Set("ETag", etag)
	h.Set("Vary", "Accept-Encoding")
	// Per-route response headers (innovation #26) ride HTML documents only:
	// the strict CSP hashes the exact inlined bundle, and a route's exported
	// headers (a tighter CSP, x-robots-tag, ...) win over it. Assets and
	// baked API bodies carry no page headers.
	if strings.HasPrefix(mimeOf(name), "text/html") {
		for k, v := range headersFor(r.URL.Path) {
			h.Set(k, v)
		}
	}
	// A matching revalidator answers 304 with the same headers and no body.
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if encoding != "" {
		h.Set("Content-Encoding", encoding)
	}
	_, _ = w.Write(body)
}

// serveFile writes the embedded file to w - build-precompressed brotli when
// the client accepts it, else the cached gzip, else raw. Returns false
// (writing nothing) when the file does not exist, so the caller can try the
// next candidate.
func serveFile(w http.ResponseWriter, r *http.Request, name string) bool {
	// Precompression siblings are internal build artifacts (innovation #28):
	// a direct request for dist/<file>.br must not answer raw brotli bytes
	// labeled as the page - it falls through to the real file (or the SPA
	// shell). A real asset that merely ends .br/.gz (no base file) serves.
	if base, ok := strings.CutSuffix(name, ".br"); ok {
		if _, ok := readDist(base); ok {
			return false
		}
	} else if base, ok := strings.CutSuffix(name, ".gz"); ok {
		if _, ok := readDist(base); ok {
			return false
		}
	}
	body, ok := readDist(name)
	if !ok {
		return false
	}
	etag, _ := etagCache.LoadOrStore(name, etagOf(body))
	tag := etag.(string)
	ae := r.Header.Get("Accept-Encoding")
	if strings.Contains(ae, "br") {
		if br, ok := readDist(name + ".br"); ok {
			writeBody(w, r, name, br, "br", tag)
			return true
		}
	}
	if strings.Contains(ae, "gzip") {
		gz, _ := gzipCache.LoadOrStore(name, gzipBytes(body))
		writeBody(w, r, name, gz.([]byte), "gzip", tag)
		return true
	}
	writeBody(w, r, name, body, "", tag)
	return true
}

var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".ico":  "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt":  "text/plain; charset=utf-8",
	".map":  "application/json; charset=utf-8",
}

func mimeOf(name string) string {
	if m, ok := mimeTypes[strings.ToLower(path.Ext(name))]; ok {
		return m
	}
	return "application/octet-stream"
}

// Per-route response headers (innovation #26). dist/headers.json is written
// by `rosefn build`: `default` carries the strict CSP (the CLI hashed the
// exact inlined bundle + bootstrap bytes - this binary has no esbuild to
// recompute them), and `routes` carries each route's exported headers.
type headerRule struct {
	Pattern string            `json:"pattern"`
	Headers map[string]string `json:"headers"`
}

type headerConfig struct {
	Default map[string]string `json:"default"`
	Routes  []headerRule      `json:"routes"`
}

var routeHeaders headerConfig

func loadRouteHeaders() {
	b, err := dist.ReadFile("dist/headers.json")
	if err != nil {
		return // no build data: responses carry the framework defaults alone
	}
	_ = json.Unmarshal(b, &routeHeaders)
}

// matchPattern mirrors the compiler's matchRoute: equal segment counts, a
// ':' segment matches anything.
func matchPattern(pattern, pathname string) bool {
	pp := strings.Split(pattern, "/")
	xp := strings.Split(pathname, "/")
	if len(pp) != len(xp) {
		return false
	}
	for i := range pp {
		if strings.HasPrefix(pp[i], ":") {
			continue
		}
		if pp[i] != xp[i] {
			return false
		}
	}
	return true
}

// headersFor merges the default headers with every matching route's
// headers, in file order: a later route wins on conflict, so a route
// overrides the strict CSP when it exports one. Keys are lower-cased:
// HTTP header names are case-insensitive, and map iteration order is
// random - an overridden header must not survive under a second spelling.
// The merged map is cached per pathname: routeHeaders is immutable after
// boot (loadRouteHeaders runs once in main), so the answer for a path can
// never change - this is one map lookup per request instead of a merge.
var headerCache sync.Map // pathname -> map[string]string

func headersFor(pathname string) map[string]string {
	if v, ok := headerCache.Load(pathname); ok {
		m, _ := v.(map[string]string)
		return m
	}
	if len(routeHeaders.Default) == 0 && len(routeHeaders.Routes) == 0 {
		return nil
	}
	out := make(map[string]string, len(routeHeaders.Default)+4)
	for k, v := range routeHeaders.Default {
		out[strings.ToLower(k)] = v
	}
	for _, r := range routeHeaders.Routes {
		if matchPattern(r.Pattern, pathname) {
			for k, v := range r.Headers {
				out[strings.ToLower(k)] = v
			}
		}
	}
	headerCache.Store(pathname, out)
	return out
}

// ---- observability (innovation #34) ---------------------------------------
//
// The binary used to answer requests and say nothing: no access log, no
// metrics, no error trail - fine for a demo, unshippable in production.
// Everything below is stdlib: one ResponseWriter wrapper, atomic counters,
// one text endpoint. ponytail: counters + a duration sum/count pair (an
// average, not a histogram - a scrape endpoint is not where you burn memory
// on buckets nobody asked for; add a histogram when a real dashboard asks).

// statusWriter captures what the handler wrote: http.ResponseWriter exposes
// neither the status code nor the byte count, and the access log needs both.
type statusWriter struct {
	http.ResponseWriter
	status  int
	bytes   int
	proxied bool
}

func (s *statusWriter) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

var (
	reqTotal  sync.Map // status code -> *atomic.Uint64
	durSumNS  atomic.Int64
	reqCount  atomic.Int64
	inFlight  atomic.Int64
	bootTime  = time.Now()
	accessLog = log.New(os.Stdout, "", 0) // one greppable line per request
)

func countStatus(code int) {
	v, _ := reqTotal.LoadOrStore(code, &atomic.Uint64{})
	v.(*atomic.Uint64).Add(1)
}

// observe wraps the handler: in-flight gauge, status/duration counters, and
// the access line. /metrics is counted like any other request - scraping is
// traffic too, and hiding it just loses data.
func observe(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		inFlight.Add(1)
		defer inFlight.Add(-1)
		start := time.Now()
		next(sw, r)
		code := sw.status
		if code == 0 {
			code = http.StatusOK
		}
		countStatus(code)
		reqCount.Add(1)
		durSumNS.Add(time.Since(start).Nanoseconds())
		via := ""
		if sw.proxied {
			via = " via=upstream"
		}
		accessLog.Printf("%s %s %s %d %dB %s%s",
			start.UTC().Format(time.RFC3339), r.Method, r.URL.Path, code, sw.bytes,
			time.Since(start).Round(time.Microsecond), via)
	}
}

// metricsHandler answers the Prometheus text exposition format (v0.0.4):
// requests per status code, a duration sum/count pair (average = sum/count),
// the in-flight gauge and uptime - everything a scrape needs to alert on.
func metricsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	var b strings.Builder
	b.WriteString("# HELP rosefn_http_requests_total Total HTTP requests by status code.\n")
	b.WriteString("# TYPE rosefn_http_requests_total counter\n")
	codes := make([]int, 0, 8)
	reqTotal.Range(func(k, _ any) bool { codes = append(codes, k.(int)); return true })
	sort.Ints(codes) // sync.Map iterates in random order; a scrape must be stable
	for _, c := range codes {
		v, _ := reqTotal.Load(c)
		fmt.Fprintf(&b, "rosefn_http_requests_total{code=\"%d\"} %d\n", c, v.(*atomic.Uint64).Load())
	}
	b.WriteString("# HELP rosefn_http_request_duration_seconds Request duration sum and count.\n")
	b.WriteString("# TYPE rosefn_http_request_duration_seconds summary\n")
	fmt.Fprintf(&b, "rosefn_http_request_duration_seconds_sum %.6f\n", float64(durSumNS.Load())/1e9)
	fmt.Fprintf(&b, "rosefn_http_request_duration_seconds_count %d\n", reqCount.Load())
	b.WriteString("# HELP rosefn_http_requests_in_flight Requests currently being served.\n")
	b.WriteString("# TYPE rosefn_http_requests_in_flight gauge\n")
	fmt.Fprintf(&b, "rosefn_http_requests_in_flight %d\n", inFlight.Load())
	b.WriteString("# HELP rosefn_uptime_seconds Process uptime.\n")
	b.WriteString("# TYPE rosefn_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "rosefn_uptime_seconds %.3f\n", time.Since(bootTime).Seconds())
	_, _ = w.Write([]byte(b.String()))
}

//
// The binary is immutable by design: it serves exactly what the build baked.
// A real app also has live routes - POST server actions, /api handlers that
// read a database, middleware that reads cookies. Those need a JS runtime,
// and the honest answer is NOT to bolt one on (goja would double the binary
// and re-implement a language): point the binary at the Node server and let
// each half do what it is good at.
//
//	UPSTREAM=http://dynamic:3000 ./rosefn-server
//
// With UPSTREAM set, everything the static half cannot answer itself is
// reverse-proxied there: any non-GET/HEAD method (server actions, form
// POSTs) and any /api path without a baked body. Without UPSTREAM the
// behavior is exactly what it always was - 405 for POSTs, the JSON 404 for
// unbaked APIs - so the pure-static deploy keeps its contract byte for byte.

var upstreamProxy *httputil.ReverseProxy

func setupUpstream() {
	u := os.Getenv("UPSTREAM")
	if u == "" {
		return
	}
	target, err := url.Parse(u)
	if err != nil {
		log.Fatalf("Rosefn: UPSTREAM %q is not a URL: %v", u, err)
	}
	upstreamProxy = httputil.NewSingleHostReverseProxy(target)
	upstreamProxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		// The error trail: a dead backend must be visible in the logs, not
		// silently turned into a 502 nobody can explain.
		log.Printf("Rosefn error: upstream %s failed for %s %s: %v", u, r.Method, r.URL.Path, err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}
	log.Printf("Rosefn: hybrid mode - non-GET requests and unbaked /api routes proxy to %s", u)
}

func proxyUpstream(w http.ResponseWriter, r *http.Request) {
	if sw, ok := w.(*statusWriter); ok {
		sw.proxied = true // the access line says where the answer came from
	}
	upstreamProxy.ServeHTTP(w, r)
}

func handler(w http.ResponseWriter, r *http.Request) {
	// /metrics is this binary's own endpoint (innovation #34): it must be
	// answered before the file candidates, or the SPA fallback would hand
	// the HTML shell to every scraper.
	if r.URL.Path == "/metrics" {
		metricsHandler(w, r)
		return
	}
	// Hybrid mode (innovation #34): the static half cannot run a POST, so a
	// server action or a form submit goes to the Node/edge backend.
	if upstreamProxy != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
		proxyUpstream(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean(r.URL.Path)
	if p == "." || p == "/" {
		p = "/index.html"
	}
	// exact file, directory index, extension-less route, or a baked API body
	// (dist/api/<route>.json, written at build time by `prerender = true`)
	candidates := []string{"dist" + p, "dist" + p + "/index.html", "dist" + p + ".html", "dist" + p + ".json"}
	for _, c := range candidates {
		if serveFile(w, r, c) {
			return
		}
	}
	// The /api namespace answers JSON, never the SPA shell: an API client that
	// hits an unbaked route must not receive HTML. Live handlers run on the
	// Node/edge server; this binary only carries GET bodies baked at build -
	// unless UPSTREAM points at that server, in which case the live handler
	// answers (innovation #34).
	if p == "/api" || strings.HasPrefix(p, "/api/") {
		if upstreamProxy != nil {
			proxyUpstream(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"api route is not baked into this binary; run it on the Node or edge server"}`))
		return
	}
	// SPA fallback: serve the shell; the boot script client-renders the route.
	if serveFile(w, r, "dist/index.html") {
		return
	}
	http.NotFound(w, r)
}

func main() {
	loadRouteHeaders()
	setupUpstream()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/", observe(handler))
	log.Printf("Rosefn single-binary server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
