import { expect, it, vi } from 'vitest';
import { prepareBatchCrop } from './prepareBatchCrop';
import type { ReviewSegment } from '../domain/cropReview';
import type { CropTemplatePage } from '../domain/batchCrop';
const segment = (id:string,page:number): ReviewSegment => ({id,sourceKey:'file-a',sourcePath:'/sample.pdf',sourceSha256:'a'.repeat(64),sourcePage:page,segmentNo:1,
  pageWidth:600,pageHeight:800,matchRect:{x0:80,y0:70,x1:160,y1:95},candidateRect:{x0:0,y0:30,x1:600,y1:180},
  finalRect:{x0:0,y0:30,x1:600,y1:180},confidence:0.8,slot:'single',layoutFingerprint:'old',mode:'candidate',manualAdjusted:false,reviewStatus:'needs_review'});
const sample = (): ReviewSegment => ({...segment('sample',1),mode:'manual',manualAdjusted:true,reviewStatus:'confirmed',finalRect:{x0:0,y0:20,x1:600,y1:200}});
const metadata = (s:ReviewSegment): CropTemplatePage => ({status:'ok',page:s.sourcePage,page_count:100,page_width:600,page_height:800,source_sha256:s.sourceSha256,
  crop_template:{status:'ready',fingerprint:'b'.repeat(64),receipts:[{anchor_y:20,title_key:'c'.repeat(64),bounds:{x0:0,y0:0,x1:600,y1:250}}]}});
it('deduplicates pages, bounds work to two slots and skips failed validations without partial writes', async()=>{
  const targets=[segment('one',2),segment('two',2),segment('three',3)];
  let active=0,peak=0;
  const describe=vi.fn(async(s:ReviewSegment)=>{peak=Math.max(peak,++active);await Promise.resolve();active--;return metadata(s);});
  const validate=vi.fn(async(s:ReviewSegment)=>{if(s.sourcePage===3)throw new Error('unrenderable');});
  const result=await prepareBatchCrop(sample(),targets,{isCurrent:()=>true,describe,validate,onProgress:vi.fn()});
  expect(peak).toBeLessThanOrEqual(2);expect(describe).toHaveBeenCalledTimes(3);expect(validate).toHaveBeenCalledTimes(2);
  expect(result.applicable.map(x=>x.after.id)).toEqual(['one','two']);expect(result.skipped[0]!.segment.id).toBe('three');
  expect(targets.every(x=>x.mode==='candidate')).toBe(true);
});
it('does not start the remaining 88 pages after cancellation while two requests are pending',async()=>{
  let current=true; const pending: (()=>void)[]=[];
  const describe=vi.fn((s:ReviewSegment)=>new Promise<CropTemplatePage>(resolve=>{pending.push(()=>resolve(metadata(s)));}));
  const promise=prepareBatchCrop(sample(),Array.from({length:89},(_,i)=>segment(`t${i}`,i+2)),{isCurrent:()=>current,describe,validate:vi.fn(),onProgress:vi.fn()});
  const rejected=expect(promise).rejects.toThrow('过期');
  expect(describe).toHaveBeenCalledTimes(2);current=false;pending.forEach(resolve=>resolve());await rejected;
  expect(describe).toHaveBeenCalledTimes(2);
});
