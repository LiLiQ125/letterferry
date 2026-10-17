export const NATURAL_PREFIX='RWX_CHAT_ONCE_';
export const NATURAL_MAX_LENGTH=1200;
export const isVerificationChallenge=value=>typeof value==='string' && /^RWX_WEB_ONCE_[A-F0-9]{24}$/.test(value);
export const isNaturalChallenge=value=>typeof value==='string' && /^RWX_CHAT_ONCE_[A-F0-9]{24}$/.test(value);
export function naturalContentFromText(value){
  if(typeof value!=='string')return null;
  const match=/^RWX_CHAT_ONCE_[A-F0-9]{24} ([\s\S]+)$/.exec(value);
  if(!match)return null;
  const content=match[1];
  if(!content.trim() || content.length>NATURAL_MAX_LENGTH)return null;
  return content;
}
export function matchesOneShotChallenge(text,challenge){
  if(isVerificationChallenge(challenge))return text===challenge;
  if(isNaturalChallenge(challenge)){
    const content=naturalContentFromText(text);
    return content!==null && text.startsWith(challenge+' ');
  }
  return false;
}
export function isOneShotReplyOrigin(text){
  return isVerificationChallenge(text) || naturalContentFromText(text)!==null;
}
