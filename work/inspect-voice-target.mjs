import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const c=new CompanionDesktopClient();
try {console.log(JSON.stringify(await c.invoke(`const t=api.getRequestTarget('/tbo/{tbo_id}/voice/calls',{parameters:{path:{tbo_id:'diagnostic-placeholder'}}});return {target:t.url,headerNames:Object.keys(t.headers),implementation:String(api.getRequestTarget).slice(0,4500)};`)));}finally{c.close();}
