import {reconnectDecision} from '../src/reconnect-policy.mjs';
const [enabled,paused,daemonRunning,hostRunning,hostResponds,hostState,unresolved]=process.argv.slice(2);
const args=[enabled,paused,daemonRunning,hostRunning,hostResponds,unresolved];
if(args.some(v=>v!=='true'&&v!=='false')||
   !['HOST_READY','HOST_UNVERIFIED','HOST_OFFLINE'].includes(hostState)){
 process.stderr.write('RECONNECT_PLAN_INVALID_INPUT\n');process.exitCode=2;
}else{
 process.stdout.write(reconnectDecision({
   enabled:enabled==='true',paused:paused==='true',
   daemonRunning:daemonRunning==='true',hostRunning:hostRunning==='true',
   hostResponds:hostResponds==='true',hostState,unresolved:unresolved==='true'
 })+'\n');
}
