// Only fixed diagnostic vocabulary may cross the browser-to-host boundary.
// Never store raw browser exceptions, URLs, message text, or capability keys.
export const FAILURE_STAGES = Object.freeze(['BEFORE_BROWSER_SEND','BROWSER_DELIVERY','BROKER_ACK','UNKNOWN_STAGE']);
export const FAILURE_CODES = Object.freeze([
  'STOPPED_AFTER_ASSIGNMENT','BROWSER_RECEIVER_MISSING','BROWSER_MESSAGE_REJECTED',
  'PAGE_NOT_READY','PAGE_BUSY','COMPOSER_NOT_EMPTY','INPUT_NOT_ACCEPTED',
  'INPUT_NOT_CONFIRMED','SEND_NOT_READY','SEND_BUTTON_NOT_FOUND','SEND_BUTTON_DISABLED','INVALID_TEXT','BOUND_TAB_NAVIGATED',
  'REPLY_TOO_LONG','ASSISTANT_TURN_NOT_FOUND','SUBMITTED_USER_TURN_NOT_FOUND','ASSISTANT_BODY_NOT_FOUND','REPLY_COMPLETION_UNVERIFIED',
  'BROWSER_RESULT_UNKNOWN','BROKER_ACK_FAILED','UNKNOWN_ERROR'
]);
const stages=new Set(FAILURE_STAGES),codes=new Set(FAILURE_CODES);
export function normalizeWebFailure(value) {
  return {
    stage: stages.has(value?.stage) ? value.stage : 'UNKNOWN_STAGE',
    code: codes.has(value?.code) ? value.code : 'UNKNOWN_ERROR'
  };
}
export function classifyBrowserFailure(error) {
  const raw=typeof error?.message==='string'?error.message:'';
  if (/Receiving end does not exist/i.test(raw)) return 'BROWSER_RECEIVER_MISSING';
  if (codes.has(raw)) return raw;
  return 'BROWSER_MESSAGE_REJECTED';
}
