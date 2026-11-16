// Turns the report page (HTML the dashboard has just built, totals only) into a PDF file, using the Edge or Chrome already installed on this computer.
// Nothing leaves this machine: scripts are stripped from the page and a content policy blocks scripts and any network request, the browser uses a throw-away profile, and every temp file is deleted afterwards.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env['LOCALAPPDATA'] || ''
  const list = [
    process.env.REPORT_BROWSER,
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]
  return list.find((p) => p && fs.existsSync(p)) || null
}

/** html (a string) -> PDF bytes. Throws an Error with a plain message when it cannot. */
export async function htmlToPdf(html) {
  const browser = findBrowser()
  if (!browser) throw new Error('No Edge or Chrome was found on this computer to make the PDF.')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquant-report-'))
  try {
    const page = path.join(dir, 'report.html'), out = path.join(dir, 'report.pdf')
    const safe = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`)
    fs.writeFileSync(page, safe, 'utf8')
    await new Promise((resolve, reject) => {
      execFile(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
        `--user-data-dir=${path.join(dir, 'profile')}`,               // a fresh profile, so a browser you already have open is left alone
        '--no-pdf-header-footer', `--print-to-pdf=${out}`,
        `file:///${page.replace(/\\/g, '/')}`,
      ], { timeout: 60000, windowsHide: true }, (err) => (err && !fs.existsSync(out) ? reject(err) : resolve()))
    })
    if (!fs.existsSync(out)) throw new Error('The browser did not produce a PDF.')
    return fs.readFileSync(out)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp folder; the OS cleans it up */ }
  }
}
