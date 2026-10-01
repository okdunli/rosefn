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
	"os"
	"path"
	"strings"
	"sync"
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

func handler(w http.ResponseWriter, r *http.Request) {
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
	// Node/edge server; this binary only carries GET bodies baked at build.
	if p == "/api" || strings.HasPrefix(p, "/api/") {
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
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/", handler)
	log.Printf("Rosefn single-binary server listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
