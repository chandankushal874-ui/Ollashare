'use client';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { useEffect, useRef, useState, type FormEvent } from 'react';
type Message = { _id: string; senderId: string; senderName: string; senderRole: string; text: string; timestamp: number };
const list = makeFunctionReference<'query', { roomCode: string }, Message[]>('screenshare:listChatMessages');
const sendMessage = makeFunctionReference<'mutation', { roomCode: string; text: string }, string>('screenshare:sendChatMessage');
export function useServerChat(roomCode: string, account: string | null, joined: boolean, live: boolean) {
  const rows = useQuery(list, joined && account && roomCode ? { roomCode } : 'skip');
  const send = useMutation(sendMessage);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const scope = `${account}:${roomCode}`;
  const context = useRef({ scope, live, joined, active: true });
  context.current = { ...context.current, scope, live, joined };
  useEffect(() => { context.current.active = true; return () => { context.current.active = false; }; }, []);
  useEffect(() => { setDraft(''); setError(null); }, [scope]);
  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current || !context.current.live || !context.current.joined || !draft.trim()) return;
    if (draft.length > 2000) { setError('Message must be at most 2000 characters.'); return; }
    const submitted = draft;
    busy.current = true; setPending(true); setError(null);
    try {
      await send({ roomCode, text: submitted });
      if (context.current.active && context.current.scope === scope) setDraft((value) => value === submitted ? '' : value);
    } catch {
      if (context.current.active && context.current.scope === scope) setError('Message not sent. Your draft was kept.');
    } finally { busy.current = false; if (context.current.active) setPending(false); }
  }
  return { messages: (joined ? rows ?? [] : []).map((row) => ({ ...row, id: row._id, isSystem: false })), draft, setDraft, error, pending, handleSend };
}
