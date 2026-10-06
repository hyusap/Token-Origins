import {Runner,handler,HTTPCapability} from '@chainlink/cre-sdk';
import {configSchema,onHttp,type Config} from './handler';
export async function main() { const runner=await Runner.newRunner<Config>({configSchema}); await runner.run(()=>[handler(new HTTPCapability().trigger({}),onHttp)]); }
