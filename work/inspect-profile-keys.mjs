import {CompanionDesktopClient} from '../src/companionDesktopClient.js';
const c=new CompanionDesktopClient();
try {console.log(JSON.stringify(await c.invoke(`const p=(await api.safeGet('/tbo/primary',{retry:false})).profile;return {profileKeys:Object.keys(p)};`)));}finally{c.close();}
