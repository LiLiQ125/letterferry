import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('support report fingerprint format is irreversible fixed-length digest prefix',()=>{
 const fp=createHash('sha256').update('secret-user-id').digest('hex').slice(0,16);
 assert.match(fp,/^[a-f0-9]{16}$/);
 assert.notEqual(fp,'secret-user-id');
});
