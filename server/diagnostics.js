import { pistonListDetails, UPLOAD_URL_BYTE_LIMIT, UPLOAD_CHUNK_CHAR_LIMIT } from './client.js';
import packageInfo from '../package.json' with { type: 'json' };

const safeVersion = value => typeof value === 'string' && value.length <= 80 && /^v?\d+(?:\.\d+)+(?:_[A-Za-z0-9]+)?$/.test(value) ? value : null;

function responseSummary(info) {
  if (!info) return { http_status: null, content_type: null, redirected: null, parsed: false };
  return {
    http_status: info.status ?? null,
    content_type: info.contentType ?? null,
    redirected: info.redirected ?? null,
    parsed: info.parsed === true,
    response_type: info.responseType ?? null,
    transport_ok: info.status >= 200 && info.status < 300 && info.parsed === true,
    ...(info.snapshot_source !== undefined ? { snapshot_source: info.snapshot_source, load_attempts: info.attempts } : {})
  };
}

function addError(errors, check, error) {
  const messages = {
    NETWORK_ERROR: 'Hubitat could not be reached.',
    HTTP_ERROR: 'Hubitat rejected the HTTP request.',
    RESPONSE_ERROR: 'Hubitat did not return parseable webCoRE data.',
    ERR_INVALID_TOKEN: 'The dashboard session is invalid or expired. Run setup locally to authenticate again.',
    ERR_INVALID_ID: 'webCoRE rejected the requested identity.',
    AUTH_ERROR: 'Dashboard authentication failed. Run setup locally.',
    WEBCORE_ERROR: 'webCoRE reported an operation error; inspect the local hub logs.',
    PISTON_LIST_UNAVAILABLE: 'The dashboard response did not contain a recognized piston list; do not report zero pistons.',
    PISTON_LIST_MALFORMED: 'The piston list contains malformed or duplicate records; no count can be verified.',
    DASHBOARD_SNAPSHOT_UNAVAILABLE: 'An unchanged dashboard marker had no matching session snapshot; counts and versions are unavailable.',
    DASHBOARD_RESPONSE_INVALID: 'The parsed response did not contain a recognized dashboard instance; HTTP success does not verify access.'
  };
  const code = Object.hasOwn(messages, error?.code ?? '') ? error.code : 'DIAGNOSTIC_ERROR';
  errors.push({ check, code, message: messages[code] ?? 'The diagnostic check failed; response values are omitted.' });
}

export async function runDiagnostics(client) {
  const report = {
    ok: false,
    plugin_version: packageInfo.version,
    webcore_version: null,
    webcore_he_version: null,
    upload_limits: { url_bytes: UPLOAD_URL_BYTE_LIMIT, chunk_chars: UPLOAD_CHUNK_CHAR_LIMIT, max_chunks: 99 },
    connection_mode: client.config.connectionMode === 'cloud' ? 'cloud' : 'local',
    credentials_included: false,
    checks: {},
    errors: []
  };

  let load;
  try {
    load = await client.getDashboard();
    report.webcore_version = safeVersion(load?.instance?.coreVersion);
    report.webcore_he_version = safeVersion(load?.instance?.heVersion);
    report.checks.dashboard = { ok: true, ...responseSummary(client.lastDashboardInfo) };
  } catch (error) {
    report.checks.dashboard = { ok: false, ...responseSummary(client.lastDashboardInfo) };
    addError(report.errors, 'dashboard', error);
  }

  if (load !== undefined) {
    let pistonDetails;
    let firstCount;
    let attempts = 1;
    try {
      pistonDetails = pistonListDetails(load);
      firstCount = pistonDetails.pistons.length;
      if (firstCount === 0) {
        attempts = 2;
        load = await client.getDashboard();
        pistonDetails = pistonListDetails(load);
      }
      const count = pistonDetails.pistons.length;
      report.checks.piston_list = {
        ok: true,
        path: pistonDetails.path,
        count,
        attempts,
        ...(attempts === 2 ? { first_count: firstCount, confirmed_empty: count === 0, changed_between_reads: count !== firstCount } : {})
      };
    } catch (error) {
      if (attempts === 1) {
        try {
          attempts = 2;
          load = await client.getDashboard();
          pistonDetails = pistonListDetails(load);
          report.checks.piston_list = {
            ok: true,
            path: pistonDetails.path,
            count: pistonDetails.pistons.length,
            attempts,
            recovered_on_retry: true
          };
        } catch (retryError) {
          report.checks.piston_list = { ok: false, attempts, ...responseSummary(client.lastDashboardInfo) };
          addError(report.errors, 'piston_list', retryError);
        }
      } else {
        report.checks.piston_list = { ok: false, attempts, ...responseSummary(client.lastDashboardInfo) };
        addError(report.errors, 'piston_list', error);
      }
    }
  } else {
    report.checks.piston_list = { ok: false, skipped: true, reason: 'dashboard request failed' };
  }

  if (load !== undefined) {
    report.webcore_version = safeVersion(load?.instance?.coreVersion);
    report.webcore_he_version = safeVersion(load?.instance?.heVersion);
  }

  try {
    const devices = await client.listDevices();
    report.checks.authorized_devices = { ok: true, count: Object.keys(devices).length };
  } catch (error) {
    report.checks.authorized_devices = { ok: false, ...responseSummary(error.responseInfo ?? client.lastResponseInfo) };
    addError(report.errors, 'authorized_devices', error);
  }

  report.ok = Object.values(report.checks).every(check => check.ok);
  return report;
}
