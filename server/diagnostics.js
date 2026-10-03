import { pistonListDetails, UPLOAD_URL_BYTE_LIMIT, UPLOAD_CHUNK_CHAR_LIMIT } from './client.js';
import packageInfo from '../package.json' with { type: 'json' };

function responseSummary(info) {
  if (!info) return { http_status: null, content_type: null, redirected: null, parsed: false };
  return {
    http_status: info.status ?? null,
    content_type: info.contentType ?? null,
    redirected: info.redirected ?? null,
    parsed: info.parsed === true,
    response_type: info.responseType ?? null
  };
}

function addError(errors, check, error) {
  errors.push({ check, code: error?.code ?? 'DIAGNOSTIC_ERROR', message: error?.message ?? 'Unknown error.' });
}

export async function runDiagnostics(client) {
  const report = {
    ok: false,
    plugin_version: packageInfo.version,
    webcore_version: null,
    webcore_he_version: null,
    upload_limits: { url_bytes: UPLOAD_URL_BYTE_LIMIT, chunk_chars: UPLOAD_CHUNK_CHAR_LIMIT, max_chunks: 99 },
    connection_mode: client.config.connectionMode ?? 'local',
    credentials_included: false,
    checks: {},
    errors: []
  };

  let load;
  try {
    load = await client.request('/intf/dashboard/load');
    report.webcore_version = load?.instance?.coreVersion ?? null;
    report.webcore_he_version = load?.instance?.heVersion ?? null;
    report.checks.dashboard = { ok: true, ...responseSummary(client.lastResponseInfo) };
  } catch (error) {
    report.checks.dashboard = { ok: false, ...responseSummary(client.lastResponseInfo) };
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
        load = await client.request('/intf/dashboard/load');
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
          load = await client.request('/intf/dashboard/load');
          pistonDetails = pistonListDetails(load);
          report.checks.piston_list = {
            ok: true,
            path: pistonDetails.path,
            count: pistonDetails.pistons.length,
            attempts,
            recovered_on_retry: true
          };
        } catch (retryError) {
          report.checks.piston_list = { ok: false, attempts, ...responseSummary(client.lastResponseInfo) };
          addError(report.errors, 'piston_list', retryError);
        }
      } else {
        report.checks.piston_list = { ok: false, attempts, ...responseSummary(client.lastResponseInfo) };
        addError(report.errors, 'piston_list', error);
      }
    }
  } else {
    report.checks.piston_list = { ok: false, skipped: true, reason: 'dashboard request failed' };
  }

  try {
    const devices = await client.listDevices();
    report.checks.authorized_devices = { ok: true, count: Object.keys(devices).length };
  } catch (error) {
    report.checks.authorized_devices = { ok: false, ...responseSummary(client.lastResponseInfo) };
    addError(report.errors, 'authorized_devices', error);
  }

  report.ok = Object.values(report.checks).every(check => check.ok);
  return report;
}
