import {test,expect} from 'bun:test';
import {replayCreProgress} from '../cre/runner';

test('CRE transcript replay preserves long submission JSON and exact transaction correlation',()=>{
  const submitted={hash:`0x${'a'.repeat(64)}`,runId:'run-fef2e11f-59bf-4140-8fea-8744eaa53526',revision:132,policyHash:`0x${'b'.repeat(64)}`};
  const line=`ORIGINS_SUBMITTED ${JSON.stringify(submitted)}`;
  expect(line.length).toBeGreaterThan(240);
  const received:string[]=[];
  replayCreProgress([line],message=>{
    received.push(message);
    expect(JSON.parse(message.slice('ORIGINS_SUBMITTED '.length))).toEqual(submitted);
  });
  expect(received).toEqual([line]);
});

test('human progress stays bounded while all machine payloads remain complete',()=>{
  const human='Compilation details '.repeat(30),machine=`ORIGINS_DECISION ${JSON.stringify({notes:'x'.repeat(300)})}`;
  const received:string[]=[];
  replayCreProgress([human,machine],message=>received.push(message));
  expect(received).toEqual([`${human.slice(0,240)}…`,machine]);
  expect(JSON.parse(received[1]!.slice('ORIGINS_DECISION '.length)).notes).toHaveLength(300);
});
