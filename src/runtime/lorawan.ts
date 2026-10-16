// LoRaWAN PHYPayload parser (v1.0.x / v1.1 on the wire, structural).
//
// Zero-dependency, Buffer-free (Uint8Array + DataView only) so the same module
// is safe in the browser bundle and in a prerender - it reads bytes, never
// touches the network or a key. The FRMPayload of a data frame is
// application-encrypted (AES-128 with AppSKey); this module returns it raw -
// decrypting is the app's business, because the key is the app's secret.
//
//   PHYPayload = MHDR(1) | MACPayload | MIC(4)
//   data frame MACPayload = DevAddr(4,LE) FCtrl(1) FCnt(2,LE) FOpts(0-15) [FPort(1)] FRMPayload

export type LoRaWANMessageType =
  | 'join-request'
  | 'join-accept'
  | 'unconfirmed-data-up'
  | 'unconfirmed-data-down'
  | 'confirmed-data-up'
  | 'confirmed-data-down'
  | 'proprietary';

export interface LoRaWANDataFrame {
  kind: 'data';
  mtype: LoRaWANMessageType;
  major: 0 | 1;
  devAddr: string; // 8 hex chars, the little-endian word as LoRaWAN prints it
  fctrl: { adr: boolean; adrAckReq: boolean; ack: boolean; classB: boolean; fOptsLen: number };
  fCnt: number;
  fOpts: Uint8Array | null;
  fPort: number | null; // null when the frame carries no port byte
  frmPayload: Uint8Array | null; // still encrypted; null when absent
  mic: Uint8Array;
}

export interface LoRaWANJoinRequest {
  kind: 'join-request';
  major: 0 | 1;
  appEUI: string; // 16 hex chars
  devEUI: string; // 16 hex chars
  devNonce: number;
  mic: Uint8Array;
}

export interface LoRaWANJoinAccept {
  kind: 'join-accept';
  major: 0 | 1;
  appNonce: string; // 6 hex chars
  netID: string; // 6 hex chars
  devAddr: string; // 8 hex chars
  mic: Uint8Array;
}

export type LoRaWANFrame = LoRaWANDataFrame | LoRaWANJoinRequest | LoRaWANJoinAccept;

const MTYPES: Record<number, LoRaWANMessageType> = {
  0: 'join-request',
  1: 'join-accept',
  2: 'unconfirmed-data-up',
  3: 'unconfirmed-data-down',
  4: 'confirmed-data-up',
  5: 'confirmed-data-down',
  6: 'proprietary',
  7: 'proprietary',
};

const HEX = '0123456789ABCDEF';
function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/**
 * Parse a LoRaWAN PHYPayload. Returns null for anything that is not a
 * well-formed frame (too short for its own headers, a truncated MIC).
 * Throws nothing - a gateway loop must never die on one bad datagram.
 */
export function parseLoRaWAN(frame: Uint8Array): LoRaWANFrame | null {
  if (!frame || frame.length < 5) return null;
  const mhdr = frame[0];
  const mtype = MTYPES[(mhdr >> 5) & 0x07];
  const major = (mhdr & 0x03) as 0 | 1;
  if (major > 1) return null;
  const body = frame.subarray(1, frame.length - 4);
  const mic = frame.subarray(frame.length - 4);
  if (body.length < 1) return null;
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  if (mtype === 'join-request') {
    if (body.length !== 18) return null;
    return {
      kind: 'join-request',
      major,
      appEUI: hex(body.subarray(0, 8)),
      devEUI: hex(body.subarray(8, 16)),
      devNonce: dv.getUint16(17, true),
      mic,
    };
  }

  if (mtype === 'join-accept') {
    if (body.length < 12) return null;
    return {
      kind: 'join-accept',
      major,
      appNonce: hex(body.subarray(0, 3)),
      netID: hex(body.subarray(3, 6)),
      devAddr: hex(body.subarray(6, 10)),
      mic,
    };
  }

  // data frames (up/down, confirmed or not)
  if (body.length < 7) return null;
  const devAddr = hex(body.subarray(0, 4));
  const fctrlB = body[4];
  const fOptsLen = fctrlB & 0x0f;
  const fCnt = dv.getUint16(6, true);
  let p = 7;
  if (p + fOptsLen > body.length) return null;
  const fOpts = fOptsLen > 0 ? body.subarray(p, p + fOptsLen) : null;
  p += fOptsLen;
  let fPort: number | null = null;
  let frmPayload: Uint8Array | null = null;
  if (p < body.length) {
    fPort = body[p];
    p += 1;
    if (p < body.length) frmPayload = body.subarray(p);
  }
  return {
    kind: 'data',
    mtype,
    major,
    devAddr,
    fctrl: {
      adr: (fctrlB & 0x80) !== 0,
      adrAckReq: (fctrlB & 0x40) !== 0,
      ack: (fctrlB & 0x20) !== 0,
      classB: (fctrlB & 0x10) !== 0,
      fOptsLen,
    },
    fCnt,
    fOpts,
    fPort,
    frmPayload,
    mic,
  };
}
