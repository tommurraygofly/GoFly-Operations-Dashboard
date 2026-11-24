/**
 * GoFly weekly email (Google Apps Script, free).
 *
 * Sends the GoFly Operations Dashboard weekly brief (IOR fuel level and use, each aircraft's
 * hours, average hours a week and maintenance forecast) from the Gmail account that owns this
 * script. Google runs it every morning; the dashboard decides whether today is the day.
 * Who gets it, which day, and on/off are set in the dashboard: Data & settings > Weekly email.
 *
 * One-off setup (about 5 minutes, easiest on a computer):
 *  1. In the dashboard, Data & settings > Weekly email: add the email addresses, choose the day,
 *     Save. Then tap "Make a key" and copy the key.
 *  2. Cloudflare dashboard > Workers & Pages > gofly-ops > Settings > Variables and Secrets >
 *     Add: type Secret, name BRIEF_KEY, value = the key. Deploy.
 *  3. Go to script.google.com, signed in as the Gmail account that should send it. New project,
 *     delete what's there and paste this whole file. Save.
 *  4. Project Settings (gear icon) > Script properties > Add:
 *       DASHBOARD_URL  the dashboard address, e.g. https://your-dashboard.workers.dev
 *       BRIEF_KEY      the same key as step 2
 *  5. Back in the editor, choose "setup" in the function list and press Run. Allow the
 *     permissions Google asks for (send email as you, connect to an external service).
 *  6. Choose "sendTestToMe" and press Run: a test copy arrives in this Gmail inbox.
 *
 * Never put the key in this file: the GitHub repo is public. It lives only in the script
 * properties and the Cloudflare secret. To change the key, make a new one and update both.
 */

// Run once: checks the dashboard every morning between 6 and 7 am Brisbane time.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(6).inTimezone('Australia/Brisbane').create();
  getBrief_(false); // checks the address and key now, so any problem shows straight away
  Logger.log('Set up. The weekly brief is checked every morning between 6 and 7 am Brisbane time.');
}

// Runs every morning. Sends only on the day chosen in the dashboard, once per day.
function dailyCheck() {
  var j = getBrief_(false);
  if (!j.send) { Logger.log('Not sending today: ' + j.reason); return; }
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('LAST_SENT') === j.date) return;
  GmailApp.sendEmail(j.to.join(','), j.subject, j.text, { htmlBody: j.html, name: 'GoFly Operations' });
  props.setProperty('LAST_SENT', j.date);
  Logger.log('Sent to ' + j.to.join(', '));
}

// Sends a test copy to this Gmail account only.
function sendTestToMe() {
  var j = getBrief_(true);
  var me = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(me, '[Test] ' + j.subject, j.text, { htmlBody: j.html, name: 'GoFly Operations' });
  Logger.log('Test sent to ' + me + '. On ' + (j.day || 'the chosen day') + ' it goes to: ' + (j.to.join(', ') || 'nobody yet (add addresses in Data & settings)'));
}

function getBrief_(force) {
  var p = PropertiesService.getScriptProperties();
  var base = String(p.getProperty('DASHBOARD_URL') || '').trim().replace(/\/+$/, '');
  var key = String(p.getProperty('BRIEF_KEY') || '').trim();
  if (!base || !key) throw new Error('Add DASHBOARD_URL and BRIEF_KEY in Project Settings > Script properties.');
  var r = UrlFetchApp.fetch(base + '/api/weekly-brief' + (force ? '?force=1' : ''), {
    headers: { 'X-Brief-Key': key }, muteHttpExceptions: true, followRedirects: true
  });
  var code = r.getResponseCode(), body = r.getContentText();
  if (code !== 200) {
    var msg = body; try { msg = JSON.parse(body).error || body; } catch (e) {}
    throw new Error('The dashboard said ' + code + ': ' + String(msg).slice(0, 300));
  }
  return JSON.parse(body);
}
