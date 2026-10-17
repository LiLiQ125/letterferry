const status=document.getElementById('status');
async function call(command,other={}) {
  try {const response=await chrome.runtime.sendMessage({command,...other}); status.textContent=response?.message||'未返回状态';}
  catch {status.textContent='扩展后台暂时不可用';}
}
document.getElementById('save').onclick=()=>call('save-key',{key:document.getElementById('key').value.trim()});
document.getElementById('bind').onclick=()=>call('bind');
document.getElementById('arm').onclick=()=>call('arm');
document.getElementById('stop').onclick=()=>call('stop');
document.getElementById('inspect').onclick=()=>call('inspect');
call('status');
