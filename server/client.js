import { createHash } from 'node:crypto';
import { isLanguageDb, languageConditionReference, observeLanguage } from './language.js';

export const UPLOAD_URL_BYTE_LIMIT = 2048;
export const UPLOAD_CHUNK_CHAR_LIMIT = 1500;
const MAX_UPLOAD_CHUNKS = 99;
const uploadSessions = new Set();

export class WebcoreError extends Error {
  constructor(message, code = 'WEBCORE_ERROR') { super(message); this.name = 'WebcoreError'; this.code = code; }
}

export function parseEndpoint(input) {
  let url;
  try { url = new URL(input); } catch { throw new WebcoreError('Expected a full Hubitat webCoRE endpoint URL.', 'CONFIG_ERROR'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebcoreError('Only HTTP(S) Hubitat URLs are supported.', 'CONFIG_ERROR');
  const accessToken = url.searchParams.get('access_token');
  const local = url.pathname.match(/^(.*\/apps\/api\/[^/]+)(?:\/.*)?$/);
  if (local && accessToken) return { baseUrl: `${url.origin}${local[1]}`, accessToken, connectionMode: 'local' };

  const cloud = url.pathname.match(/^\/api\/([^/]+)\/apps\/([^/]+)(?:\/.*)?$/);
  if (url.hostname === 'cloud.hubitat.com' && cloud && accessToken) {
    return { baseUrl: `${url.origin}/api/${cloud[1]}/apps/${cloud[2]}`, accessToken, connectionMode: 'cloud' };
  }
  throw new WebcoreError('URL must be a local /apps/api/<appId> endpoint, or a cloud.hubitat.com /api/<hubId>/apps/<appId> endpoint, and include an access_token query parameter.', 'CONFIG_ERROR');
}

export function hashPin(pin) { return createHash('md5').update(`pin:${pin}`).digest('hex'); }

export function parseWebcoreResponse(body) {
  try { return JSON.parse(body); } catch { /* webCoRE returns callback-wrapped JSON from its dashboard endpoints */ }
  const wrapped = body.trim().match(/^null\s*\(([\s\S]*)\)\s*;?$/);
  if (!wrapped) throw new SyntaxError('Response is neither JSON nor JSONP.');
  return JSON.parse(wrapped[1]);
}

export function pistonListDetails(data) {
  const candidates = [data?.instance?.pistons, data?.pistons, data?.pistonList, data?.piston];
  const index = candidates.findIndex(value =>
    Array.isArray(value) || (value !== null && typeof value === 'object')
  );
  if (index < 0) {
    throw new WebcoreError('webCoRE response did not include a recognized piston list.', 'PISTON_LIST_UNAVAILABLE');
  }
  const raw = candidates[index];
  const paths = ['instance.pistons', 'pistons', 'pistonList', 'piston'];
  const path = paths[index];
  if (Array.isArray(raw)) return { path, pistons: raw };
  const pistons = Object.entries(raw)
    .filter(([, piston]) => piston !== null && typeof piston === 'object' && !Array.isArray(piston))
    .map(([key, piston]) => ({ ...piston, id: piston.id ?? piston.i ?? key }));
  return { path, pistons };
}

export function normalizePistonList(data) {
  return pistonListDetails(data).pistons;
}

export class WebcoreClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.base = config.baseUrl.replace(/\/$/, '');
    this.accessToken = config.accessToken;
    this.securityToken = config.securityToken;
    this.debug = config.debug;
  }
  requestUrl(path, params = {}, { authenticated = true } = {}) {
    const url = new URL(`${this.base}${path}`);
    url.searchParams.set('access_token', this.accessToken);
    if (authenticated && this.securityToken) url.searchParams.set('token', this.securityToken);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    return url;
  }
  requestUrlBytes(path, params = {}) {
    return Buffer.byteLength(this.requestUrl(path, params).href, 'utf8');
  }
  async request(path, params = {}, options = {}) {
    const url = this.requestUrl(path, params, options);
    this.lastResponseInfo = null;
    let response;
    this.debug?.(`request path=${path}; query values omitted`);
    try { response = await this.fetch(url, { signal: AbortSignal.timeout(15000) }); }
    catch (error) {
      const code = typeof error?.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(error.cause.code) ? error.cause.code : 'REQUEST_FAILED';
      this.debug?.(`network request failed; code=${code}`);
      throw new WebcoreError(`Hubitat network request failed (${code}). Check that the hub is reachable and the endpoint is correct.`, 'NETWORK_ERROR');
    }
    const rawContentType = response.headers?.get('content-type') ?? '';
    const contentType = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w=.+-]+)*$/.test(rawContentType) ? rawContentType : (rawContentType ? 'other/unknown' : 'not provided');
    this.lastResponseInfo = {
      path,
      status: response.status,
      contentType: contentType.split(';', 1)[0],
      redirected: Boolean(response.redirected),
      parsed: false
    };
    this.debug?.(`response status=${response.status}; content-type=${contentType}; redirected=${Boolean(response.redirected)}`);
    const body = await response.text();
    if (!response.ok) {
      const error = new WebcoreError(`Hubitat returned HTTP ${response.status}.`, 'HTTP_ERROR');
      error.httpStatus = response.status;
      throw error;
    }
    let data;
    try { data = parseWebcoreResponse(body); } catch {
      const redirectNote = response.redirected ? ' after a redirect' : '';
      throw new WebcoreError(`Hubitat returned a non-JSON response${redirectNote} (HTTP ${response.status}, ${contentType}). Check the local endpoint and whether Hubitat or a proxy is returning a login page.`, 'RESPONSE_ERROR');
    }
    this.lastResponseInfo = {
      ...this.lastResponseInfo,
      parsed: true,
      responseType: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data
    };
    if (data?.error === 'ERR_INVALID_TOKEN' || data?.error === 'ERR_INVALID_ID') throw new WebcoreError(`webCoRE rejected the request (${data.error}). Re-authenticate and check the piston ID.`, data.error);
    if (data?.status === 'ST_ERROR') throw new WebcoreError(`webCoRE operation failed (${data.error ?? 'unspecified error'}).`, 'WEBCORE_ERROR');
    return data;
  }
  async authenticate(pin) {
    const data = await this.request('/intf/dashboard/load', { pin: hashPin(pin) }, { authenticated: false });
    const token = data?.instance?.token;
    if (!token) throw new WebcoreError('PIN was not accepted or webCoRE did not return a session token.', 'AUTH_ERROR');
    this.securityToken = token;
    return { ...data, securityToken: token };
  }
  async listDevices() {
    const devices = {};
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const part = await this.request('/intf/dashboard/devices', { offset });
      Object.assign(devices, part.devices ?? {});
      if (part.complete === true || part.nextOffset == null) {
        const states = await this.refreshStates();
        for (const [id, definition] of Object.entries(devices)) {
          if (states?.[id] !== undefined) definition.currentState = states[id];
        }
        return devices;
      }
      if (!Number.isInteger(Number(part.nextOffset)) || Number(part.nextOffset) <= offset) throw new WebcoreError('webCoRE returned an invalid device pagination offset.');
      offset = Number(part.nextOffset);
    }
    throw new WebcoreError('Device inventory exceeded the 100-page safety limit.');
  }
  async refreshStates() { return this.request('/intf/dashboard/refresh'); }
  async listPistons() {
    const data = await this.request('/intf/dashboard/load');
    return normalizePistonList(data);
  }
  getPiston(id) { return this.request('/intf/dashboard/piston/get', { id, db: '' }); }
  async getLanguageDb() {
    const [language, dashboard] = await Promise.allSettled([
      this.request('/intf/dashboard/piston/getDb'), this.request('/intf/dashboard/load')
    ]);
    if (language.status === 'rejected') throw language.reason;
    if (!isLanguageDb(language.value)) throw new WebcoreError('webCoRE did not return a nonempty language database. Definitions and compatibility could not be checked.', 'LANGUAGE_DB_UNAVAILABLE');
    const raw = language.value;
    const versionError = dashboard.status === 'rejected' ? dashboard.reason?.code ?? 'REQUEST_FAILED' : null;
    const safeVersionError = versionError && /^[A-Z][A-Z0-9_]{0,63}$/.test(versionError) ? versionError : versionError ? 'REQUEST_FAILED' : null;
    const compatibility = await observeLanguage(this.config, dashboard.status === 'fulfilled' ? dashboard.value : null, raw, safeVersionError);
    this.debug?.(`language check=${compatibility.observation_status}; reference=${compatibility.reference_status}; tracking saved=${compatibility.tracking.saved}; credentials omitted`);
    return { ...raw, language_compatibility: compatibility, condition_reference: languageConditionReference(compatibility) };
  }
  getActivity(id, log = 0) { return this.request('/intf/dashboard/piston/activity', { id, log }); }
  testPiston(id) { return this.request('/intf/dashboard/piston/test', { id }); }
  createPiston(name) { return this.request('/intf/dashboard/piston/create', { name }); }
  pausePiston(id) { return this.request('/intf/dashboard/piston/pause', { id }); }
  resumePiston(id) { return this.request('/intf/dashboard/piston/resume', { id }); }
  setPiston(id, encodedData, options) { return this.savePiston(id, encodedData, options); }

  planPistonChunks(id, encodedData, { urlByteLimit = UPLOAD_URL_BYTE_LIMIT, chunkCharLimit = UPLOAD_CHUNK_CHAR_LIMIT } = {}) {
    if (typeof encodedData !== 'string' || !encodedData.length) throw new WebcoreError('Piston upload payload is empty.', 'EMPTY_UPLOAD');
    const chunks = [];
    for (let offset = 0; offset < encodedData.length;) {
      let low = 0;
      let high = Math.min(chunkCharLimit, encodedData.length - offset);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const params = { id, chunk: chunks.length, data: encodedData.slice(offset, offset + mid) };
        if (this.requestUrlBytes('/intf/dashboard/piston/set.chunk', params) <= urlByteLimit) low = mid;
        else high = mid - 1;
      }
      if (!low) throw new WebcoreError('Upload URL overhead exceeds the safe limit; no payload can be sent.', 'UPLOAD_URL_LIMIT');
      chunks.push(encodedData.slice(offset, offset + low));
      offset += low;
      if (chunks.length > MAX_UPLOAD_CHUNKS) throw new WebcoreError('Piston payload exceeds webCoRE’s 99-chunk limit at this URL size. This upload plan was not started.', 'UPLOAD_TOO_LARGE');
    }
    for (const [path, params] of [
      ['/intf/dashboard/piston/set.start', { id, chunks: chunks.length }],
      ['/intf/dashboard/piston/set.end', { id }]
    ]) {
      if (this.requestUrlBytes(path, params) > urlByteLimit) throw new WebcoreError('Upload URL overhead exceeds the safe limit.', 'UPLOAD_URL_LIMIT');
    }
    return chunks;
  }

  async uploadRequest(path, params, trace) {
    const url_bytes = this.requestUrlBytes(path, params);
    this.debug?.(`upload path=${path}; url bytes=${url_bytes}; query values omitted`);
    try {
      const result = await this.request(path, params);
      trace.push({ path, http_status: this.lastResponseInfo?.status ?? null, url_bytes });
      return result;
    } catch (error) {
      trace.push({ path, http_status: error.httpStatus ?? this.lastResponseInfo?.status ?? null, url_bytes });
      error.details = {
        upload_stage: path.split('/').pop(),
        commit_confirmation_unknown: ['/intf/dashboard/piston/set', '/intf/dashboard/piston/set.end'].includes(path) && error.httpStatus !== 414,
        request_trace: structuredClone(trace)
      };
      throw error;
    }
  }

  async setPistonChunked(id, encodedData, { beforeCommit, urlByteLimit = UPLOAD_URL_BYTE_LIMIT, chunkCharLimit = UPLOAD_CHUNK_CHAR_LIMIT, trace = [] } = {}) {
    const chunks = this.planPistonChunks(id, encodedData, { urlByteLimit, chunkCharLimit });
    await beforeCommit?.();
    const start = await this.uploadRequest('/intf/dashboard/piston/set.start', { id, chunks: chunks.length }, trace);
    if (start.status !== 'ST_READY') throw new WebcoreError('Chunk upload did not return ST_READY.', 'UPLOAD_NOT_READY');
    for (let i = 0; i < chunks.length; i++) {
      const part = await this.uploadRequest('/intf/dashboard/piston/set.chunk', { id, chunk: i, data: chunks[i] }, trace);
      if (part.status !== 'ST_READY') throw new WebcoreError(`Chunk ${i} was not accepted.`, 'UPLOAD_NOT_READY');
    }
    // Only set.end commits the staged chunks. Re-read the piston immediately before it.
    await beforeCommit?.();
    const end = await this.uploadRequest('/intf/dashboard/piston/set.end', { id }, trace);
    if (end.status !== 'ST_SUCCESS') throw new WebcoreError('webCoRE did not confirm the final upload with ST_SUCCESS. Check the live piston before retrying.', 'UPLOAD_NOT_CONFIRMED');
    return { start, end, upload: { mode: 'chunked', chunks: chunks.length, largest_chunk_chars: Math.max(...chunks.map(chunk => chunk.length)), url_byte_limit: urlByteLimit } };
  }

  async savePiston(id, encodedData, { beforeCommit } = {}) {
    if (typeof encodedData !== 'string' || !encodedData.length) throw new WebcoreError('Piston upload payload is empty.', 'EMPTY_UPLOAD');
    const session = createHash('sha256').update(JSON.stringify([this.base, this.securityToken])).digest('hex');
    if (uploadSessions.has(session)) throw new WebcoreError('Another piston upload is using this webCoRE session. Wait for it to finish before applying this update.', 'UPLOAD_BUSY');
    uploadSessions.add(session);
    const trace = [];
    try {
      if (this.requestUrlBytes('/intf/dashboard/piston/set', { id, data: encodedData }) <= UPLOAD_URL_BYTE_LIMIT) {
        await beforeCommit?.();
        try {
          const result = await this.uploadRequest('/intf/dashboard/piston/set', { id, data: encodedData }, trace);
          if (result.status !== 'ST_SUCCESS') throw new WebcoreError('webCoRE did not confirm the upload with ST_SUCCESS. Check the live piston before retrying.', 'UPLOAD_NOT_CONFIRMED');
          return { ...result, upload: { mode: 'single', chunks: 1, request_trace: trace } };
        } catch (error) {
          if (error.httpStatus !== 414) throw error;
          // An explicit 414 rejected the request. Other failures may have committed; do not retry them.
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const options = {
          beforeCommit,
          urlByteLimit: Math.floor(UPLOAD_URL_BYTE_LIMIT / 2 ** attempt),
          chunkCharLimit: Math.floor(UPLOAD_CHUNK_CHAR_LIMIT / 2 ** attempt),
          trace
        };
        try {
          const result = await this.setPistonChunked(id, encodedData, options);
          return { ...result.end, upload: { ...result.upload, attempts: attempt + 1, request_trace: trace } };
        } catch (error) {
          // Retry only rejected staging requests; set.end can commit and must never be replayed automatically.
          if (error.httpStatus !== 414 || error.details?.upload_stage === 'set.end' || attempt === 2) throw error;
        }
      }
    } catch (error) {
      if (!error.details) error.details = {
        upload_stage: error.code === 'STALE_PISTON' ? 'hash_check' : trace.at(-1)?.path.split('/').pop() ?? 'planning',
        commit_confirmation_unknown: error.code === 'UPLOAD_NOT_CONFIRMED',
        request_trace: structuredClone(trace)
      };
      throw error;
    } finally {
      uploadSessions.delete(session);
    }
  }
}
