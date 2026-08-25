# INTEGRATE-NEXT

Everything below is blocked on the four files this pass was not allowed to edit:
`bridge/server.js`, `bridge/public/app.js`, `bridge/public/style.css`,
`scripts/class-chat.js`. The code on the other side of each line already exists and is
tested. Nothing here needs design work; it is all wiring.

Line numbers are against the files as of 2026-08-24 (`bridge/server.js` 1605 lines,
`bridge/public/index.html` 326 lines). If they have moved, the anchor text quoted with each
edit is unique — search for that instead.

---

## 1. Mount the progress route — 3 lines, `bridge/server.js`

Without this, `GET /api/index-progress` 404s and `/app/progress.html` renders nothing but
its own "route not mounted" banner. `grep -c index-progress bridge/server.js` is currently
**0**.

**Edit A — after line 34**, at the end of the import block. The last import there today is:

```js
import { recoverMeetingTimes, writeMeetingOverride, clearMeetingOverride, describeMeetingSource } from '../scripts/meeting-times.js';
```

Add below it:

```js
import { indexProgressRouter } from './routes/index-progress.js';
```

**Edit B — after line 736.** Those two lines read:

```js
  const dashRouter = express.Router();
  dashRouter.use(requireSecret(config));
```

Add immediately after them:

```js
  // Mounted on dashRouter so it inherits requireSecret above; the route file
  // deliberately carries no auth of its own rather than a second timing-safe
  // compare to keep in step with this one.
  dashRouter.use(indexProgressRouter({ syncHome, pipelineStatus, bridgePid: process.pid }));
```

`syncHome` is already in scope (`bridge/server.js:45`, `const syncHome = dataRoot;`) and
`pipelineStatus` is already imported (`bridge/server.js:20`, from `./trigger.js`). No other
argument is needed: `buildProgress` defaults to resolving `scripts/index-progress.js`
itself. The router throws at mount time if `syncHome` is not a function, so a wiring mistake
fails at boot rather than silently reporting zero classes.

Placement matters only in that it must be **after** `dashRouter.use(requireSecret(config))`
and **before** `app.use('/api', dashRouter);` (line 1555). Anywhere in that span works.

**Check it, in this order:**

```sh
cd /Users/tempadmin/CANVASync/canvas-sync
node --test bridge/test/index-progress-route.test.js   # expect 20 pass / 0 fail
node --check bridge/server.js
```

Then restart the bridge and open `http://127.0.0.1:3847/app/progress.html`. The page stores
the bridge secret under the same `localStorage` key `app.js` uses (`bridgeSecret`), so a
browser already signed in to `/app` will not see the secret gate.

---

## 2. The navigation link — 1 line, `bridge/public/index.html`, after the redesign

`index.html` is not on the forbidden list, but the redesign workflow is rewriting this
markup, so applying it now would simply be overwritten. Add it once the redesign lands.

The nav block today is lines 35–39:

```html
      <div class="topnav">
        <button data-view="classes" class="nav-btn active">Classes</button>
        <button data-view="calendar" class="nav-btn">Calendar</button>
        <button data-view="settings" class="nav-btn">Settings</button>
      </div>
```

Add after line 38 (the Settings button):

```html
        <a class="nav-btn" href="/app/progress.html">Status</a>
```

Deliberately an `<a>`, not a `<button data-view="...">`: `progress.html` is a separate
self-contained page, not a view inside the SPA. A `data-view` button would need a matching
case in `app.js`'s `navTo()` (`app.js:34`) and a `.view` section in `index.html`, which is
three more edits in a file the redesign owns. The link needs nothing from `app.js` at all.

One CSS note for whoever owns the redesign: `.nav-btn` is currently styled as a `button`.
An `<a>` carrying that class will need `text-decoration: none` and the same padding, or it
will sit a few pixels off its neighbours. `progress.html` itself is self-contained and does
not read `style.css`, so the cream palette has to be applied inside `progress.html`
separately — its tokens are defined at the top of its own `<style>` block.

---

## 3. Also blocked on these four files

**a. `/api/classes` should return `slug` alongside `folder`** — this is VERIFY row 23a and
it is still open. `bridge/server.js:775` builds each row as:

```js
      out.push({
        folder,
        courseId: folder.split('-')[0],
```

Add one line:

```js
        slug: folder.replace(/^[0-9]+-/, ''),
```

`/api/class-colors`, `/api/calendar/plan` and `sync-calendar.js`'s `classSlugOf` all key by
the stripped slug (`busi-380-002`) while `/api/classes` returns `folder` with the id still
on it (`93903-busi-380-002`). The two maps do not join, so a sidebar looking a colour up by
`folder` gets `undefined` and every class renders in the fallback colour. `app.js:1536`
already re-derives the strip client-side (`calFolder()`), which is the third copy of that
rule in the codebase.

**b. `bridge/server.js:708` still holds a private copy of the class-directory regex:**

```js
  const CLASS_RE = /^[0-9]+-[a-z0-9-]+$/;
```

There were five copies of this. Four are now one import — `scope.js` exports `CLASS_DIR_RE`
and `scripts/index-progress.js`, `bridge/routes/index-progress.js` and
`scripts/sync-all-contexts.js` import it. This is the last one. Replace the declaration with
nothing and add `CLASS_DIR_RE` to the existing `../scope.js` import on line 22:

```js
import { readSyncScope, readEnrolledCourses, isInScope, SCOPE_FILE, CLASS_DIR_RE } from '../scope.js';
```

then rename the three `CLASS_RE.test(...)` uses. Behaviourally identical today — the two
patterns are character-for-character the same — so this is drift prevention, not a fix.

**c. `scripts/class-chat.js` — nothing outstanding from this pass.** Listed only so the
absence is explicit: `scripts/text-search.js` was already merged into it (VERIFY 21a) before
the file was locked.
