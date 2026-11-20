/** Browse limits shared by the server query and the client that pages against it.
 *
 *  Its own module because explorer.tsx is a CLIENT component: importing a VALUE from lib/browse.ts
 *  drags that module's `postgres` dependency into the browser bundle and fails the build. (Its
 *  `import type` is erased at compile time, which is why only a value import breaks it — and why
 *  tsc --noEmit cannot catch this. The Vercel build can.) Nothing here may import anything.
 */

/** Hard ceiling on rows returned by ONE browse request. The Explorer must page with `offset`
 *  past this, not ask for a bigger window: shared so the client cannot drift from it and sit
 *  there offering a "Load more" that the server will silently clamp away. */
export const ROW_CAP = 1000;
