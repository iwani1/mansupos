const MAX_BYTES=10*1024*1024;
const allowed=new Set(['application/pdf','image/png','image/jpeg']);

// Never transmit file contents. This fingerprint is a BYTES integrity check,
// not verification of a human witness, file authenticity, content or signing.
export async function fingerprintPrivateCountFile(file){
  if(!file||typeof file.arrayBuffer!=='function'||
     !Number.isSafeInteger(file.size)||file.size<8||
     file.size>MAX_BYTES||!allowed.has(file.type))
    throw new Error('Choose a PDF, PNG or JPEG between 8 bytes and 10 MB.');
  if(!globalThis.crypto?.subtle?.digest)
    throw new Error('Secure local file hashing is unavailable. Use a secure HTTPS browser.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size)throw new Error('File size changed during local reading.');
  const magic={
    'application/pdf':()=>bytes[0]===37&&bytes[1]===80&&bytes[2]===68&&
      bytes[3]===70&&bytes[4]===45,
    'image/png':()=>[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),
    'image/jpeg':()=>bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
  };
  if(!magic[file.type]())
    throw new Error('File header does not match its declared PDF, PNG or JPEG format.');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  const fileSha256=Array.from(new Uint8Array(digest),n=>
    n.toString(16).padStart(2,'0')).join('');
  return {fileSha256,fileBytes:file.size,mime:file.type};
}
export function comparePrivateCountFile(local,manifest){
  if(!local||!manifest||typeof manifest.fileSha256!=='string')return 'not_checked';
  return local.fileSha256===manifest.fileSha256&&
    local.fileBytes===manifest.fileBytes&&
    local.mime===manifest.mime?'bytes_match':'bytes_differ';
}
