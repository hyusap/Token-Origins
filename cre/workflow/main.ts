import {Runner,handler,HTTPCapability,CronCapability} from '@chainlink/cre-sdk';
import {configSchema,onHttp,onCron,type Config} from './handler';
/** Default cadence when no standing policy is configured; the runner sets one per watch. */
const DEFAULT_SCHEDULE='0 */5 * * * *';
export async function main() {
  const runner=await Runner.newRunner<Config>({configSchema});
  // Trigger 0: one execution per HTTP request. Trigger 1: the standing policy, re-checked on its schedule.
  await runner.run((config)=>[
    handler(new HTTPCapability().trigger({}),onHttp),
    handler(new CronCapability().trigger({schedule:config.watch?.schedule??DEFAULT_SCHEDULE}),onCron),
  ]);
}
