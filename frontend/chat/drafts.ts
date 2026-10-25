import type {Attachment} from "@assistant-ui/react";
import type {TurnSettings} from "./model";

export interface DraftRecord {
 text: string; images: {id:string;name:string;contentType:string;url:string}[];
 settings: TurnSettings; project: string;
 reading: {top:number;bottom:boolean;anchor:string;offset:number}; updated: number;
}
export const draftStorageKey = (key: string) => "workhub:chat-draft:v1:" + key;
export function readLocalDraft(key:string): DraftRecord | undefined {
 try {const value = JSON.parse(localStorage.getItem(draftStorageKey(key)) || "null"); return validDraft(value) ? value : undefined;} catch {return undefined;}
}
export function validDraft(value: unknown): value is DraftRecord {
 const d=value as DraftRecord | null;
 return !!d && typeof d.text==="string" && typeof d.updated==="number" && !!d.settings && !!d.reading && Array.isArray(d.images);
}
export function cacheDraft(key:string,record:DraftRecord) {
 // Large images are persisted in the environment database; localStorage is a
 // fast text cache and can be unavailable or scoped to an old desktop port.
 try {localStorage.setItem(draftStorageKey(key),JSON.stringify({...record,images:[]}));} catch { /* DB remains authoritative. */ }
}
export function draftImages(attachments: readonly Attachment[]): DraftRecord['images'] {
 return attachments.flatMap(a=>(a.content||[]).flatMap(p=>p.type==="image" && p.image.startsWith("data:image/") ? [{id:a.id,name:a.name,contentType:a.contentType||"image/png",url:p.image}] : []));
}
export function restoreImages(images:DraftRecord['images']): readonly Attachment[] {
 return images.filter(i=>typeof i.url==="string"&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(i.url)).slice(0,4).map(i=>({id:i.id,type:"image" as const,name:i.name,contentType:i.contentType,status:{type:"complete" as const},content:[{type:"image" as const,image:i.url}]}));
}
