export type UploadTicket = { url: string; token: string };
export async function uploadFile(ticket: UploadTicket, file: File) {
  const response = await fetch(ticket.url, {
    method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${ticket.token}` },
    body: file,
  });
  if (!response.ok) throw new Error('Upload rejected');
  const result = await response.json();
  if (typeof result.storageId !== 'string') throw new Error('Invalid upload result');
  return result as { storageId: string };
}
