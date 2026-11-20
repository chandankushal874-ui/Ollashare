# Shared Browser Backend Integration

The frontend intentionally does not create VNC, noVNC, WebSocket, or token URLs. It accepts only a backend-issued `viewerUrl` whose grant expires within five minutes.

Expected same-origin API contract:

- `GET /api/shared-browser/sessions/current?roomCode=...` returns the active session or `null`.
- `POST /api/shared-browser/sessions` provisions a room-scoped isolated browser.
- `POST /api/shared-browser/sessions/:sessionId/grants` issues a participant-bound `controller` or `view-only` grant.
- `DELETE /api/shared-browser/sessions/:sessionId/grants/:grantId` revokes a grant.
- `POST /api/shared-browser/sessions/:sessionId/terminate` terminates the isolated browser.

Backend requirements still to implement:

- Authenticate the caller and derive authorization server-side; do not trust `participantId`, `roomCode`, or requested access by themselves.
- Restrict provision, controller grants, revocation, and termination to the current room host.
- Bind grants to the room, session, participant, and access level; make them single-use or otherwise replay-resistant.
- Return only an HTTPS viewer URL (localhost HTTP is accepted for development) with no embedded username or password.
- Expire grants in five minutes or less and immediately invalidate them on revoke, room end, participant removal, or browser termination.
- Apply clickjacking/CSP rules that explicitly allow the Ollashare app to frame the viewer, and enforce controller versus view-only behavior inside the viewer service.
- Publish browser-session lifecycle changes to room participants so guests can discover newly provisioned sessions without manual reconnect/status retry.

## Annotation overlay contract

`SharedBrowserPanel` renders `SharedBrowserAnnotationOverlay` as a sibling
above the iframe. It never sends annotation data through RFB or the viewer
URL. The parent page should provide these optional props:

```ts
type SharedBrowserPanelProps = {
  roomCode: string;
  participantId: string;
  hostId?: string;
  isHost: boolean;
  participants?: Array<{ id: string; name: string }>;
  annotationPermissions?: AnnotationPermissionSnapshot;
  annotationStrokes?: AnnotationStroke[];
  onAnnotationSend?: (message: AnnotationMessage) => void;
  onAnnotationSubscribe?: (
    listener: (message: unknown, senderId?: string) => void,
  ) => () => void;
};
```

`annotationPermissions.allowedUserIds` is the authoritative permission
snapshot for drawing guests. `onAnnotationSubscribe` must provide the
authenticated room transport sender separately as `senderId`; the overlay
rejects messages whose transport sender does not match `authorId`, whose
target is not `shared-browser` plus the current `session.id`, or whose guest
stroke ownership is not in the current snapshot. The host may clear all;
guests can only clear/erase their own strokes. Drawing mode captures the
overlay canvas pointer events and disables iframe browser control; toggling it
off restores browser control.
