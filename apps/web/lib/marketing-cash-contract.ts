import {createHash} from 'node:crypto';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function normalizeMarketingCash(body:string){
 const fail=(field:string):never=>{throw Object.assign(new Error('Invalid projection'),{field});};
 if(Buffer.byteLength(body)>16384)fail('body');
 const v=JSON.parse(body);
 if(!v||typeof v!=='object'||Array.isArray(v))fail('body');
 if(v.schemaVersion!==1)fail('schemaVersion');
 const id=(x:unknown,f:string)=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x)?x:fail(f);
 id(v.eventId,'eventId');
 const t=typeof v.occurredAt==='string'&&/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(v.occurredAt);
 if(!t)return fail('occurredAt');
 const occurredAt=`${t[1]}.${(t[2]??'').padEnd(3,'0')}Z`;
 const ms=Date.parse(occurredAt);
 if(!Number.isFinite(ms)||new Date(ms).toISOString()!==occurredAt)fail('occurredAt');
 const purchase=v.eventType==='purchase';
 if(!purchase&&v.eventType!=='refund')fail('eventType');
 const allowed=['schemaVersion','eventId','occurredAt','eventType','transactionId','customerId','amountMinor','currency',...(purchase?['subjectId','purchaseKind']:['originalTransactionId'])];
 if(Object.keys(v).some(k=>!allowed.includes(k)))fail('body');
 const semantic: Record<string, unknown>={schemaVersion:1,occurredAt,eventType:v.eventType,transactionId:id(v.transactionId,'transactionId')};
 if(!purchase)semantic.originalTransactionId=id(v.originalTransactionId,'originalTransactionId');
 semantic.customerId=id(v.customerId,'customerId');
 if(purchase)semantic.subjectId=v.subjectId==null?null:id(v.subjectId,'subjectId');
 if(typeof v.amountMinor!=='string'||! /^[1-9][0-9]{0,14}$/.test(v.amountMinor))fail('amountMinor');
 semantic.amountMinor=v.amountMinor;
 if(!['USD','GBP'].includes(v.currency))fail('currency');
 semantic.currency=v.currency;
 if(purchase){if(!['top_up','subscription_initial','subscription_renewal','auto_reload','other_sale'].includes(v.purchaseKind))fail('purchaseKind');semantic.purchaseKind=v.purchaseKind;}
 const semanticJson=JSON.stringify(semantic);
 return {semanticJson,semanticDigest:hash('unified-ads/conversion-event-semantic/v1\n'+semanticJson),businessIdentity:JSON.stringify([v.eventType,v.transactionId]), eventType: v.eventType as "purchase" | "refund", transactionId: v.transactionId as string, originalTransactionId: purchase ? null : v.originalTransactionId as string, customerId: v.customerId as string, occurredAt, currency: v.currency as string, amountMinor: v.amountMinor as string};
}
