# Epistle

Write your ministry newsletters with an AI assistant, and get them to your partners — either
through [Stello](https://stello.news) (encrypted, interactive, retractable) or as ordinary email.

Epistle is an [MCP](https://modelcontextprotocol.io) server, so it plugs into Claude, ChatGPT, or
any other assistant that speaks MCP. It runs on your own computer; your partner list, your
newsletters and your email credentials never leave it.

*ἐπιστολή — a letter sent to.* The apostolic letters were written to the churches and partners
who supported the work. That is what a ministry partner newsletter still is.

You describe the update; your assistant writes it, shows you a preview, and hands it to Stello as
a real draft. **You review it and press Send.** Nothing reaches a partner without you seeing it
first.

---

## Why it works this way

Stello is an Electron desktop app. Every newsletter lives in an IndexedDB database inside the app
on your computer, each copy is encrypted in the app before it leaves, and the invitation emails go
out through your own email account. There is no server and no API for an outside program to call.

There is, however, one supported door: Stello can **restore from a backup file**. Its importer
(`app/src/services/backup/database.ts`) adds each record with IndexedDB's `add()`, which refuses
a key that already exists. So an import can only ever **add** records — it cannot modify or delete
anything already in Stello.

Epistle writes that file. It never touches Stello's database directly, never handles your
encryption keys, and never sends on your behalf through Stello.

```
  Your AI ──▶ Epistle ──▶ stello-import-<id>.json
                                          │
                                  you import it in Stello
                                          ▼
                              a real draft in your Drafts list
                                          │
                                  you review it, press Send
                                          ▼
                    Stello encrypts a copy per partner, uploads them,
                    and emails each partner a private link from your
                    own email account
```

The one thing Epistle cannot do is press Send for you. For a newsletter going to real
supporters, that turns out to be the feature.

---

## Install

You need [Node.js](https://nodejs.org) 20 or newer — download the LTS installer, click through it,
done. That is the only prerequisite.

Then pick how your AI connects.

> Epistle is not on npm yet, so the commands below install it straight from GitHub. That works
> today — npm fetches it, compiles it and caches it for you, so only the very first run is slow
> (a few seconds after that). Once it is published, `github:xerxesduane/ministry-newsletters`
> shortens to `epistle-mcp` everywhere below and nothing else changes.

### Claude Desktop, Claude Code, and anything else that runs a local tool

These launch Epistle themselves. Nothing to install by hand.

**Claude Desktop** — Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "epistle": {
      "command": "npx",
      "args": ["-y", "github:xerxesduane/ministry-newsletters"]
    }
  }
}
```

Restart Claude Desktop. That is the whole setup.

**Claude Code** — one line:

```bash
claude mcp add epistle -- npx -y github:xerxesduane/ministry-newsletters
```

### ChatGPT, and other agents that connect to a URL

These cannot launch a program on your computer; they connect to an address. So run Epistle
yourself, then give the agent its URL:

```bash
npx -y github:xerxesduane/ministry-newsletters --http
```

```
Epistle 0.2.0 is running.

  MCP endpoint   http://127.0.0.1:8765/mcp
  Access         this computer only

Add that URL to your agent as a custom MCP connector. Press Ctrl+C to stop.
```

Add that URL as a custom MCP connector. Leave the window open while you work.

> **A URL-based agent must be able to reach that address.** `127.0.0.1` means *this computer only*,
> which is right for an agent running on the same machine. A cloud assistant — ChatGPT on the web
> among them — cannot see it. To reach Epistle from elsewhere you have to expose it deliberately,
> and then it needs a token:
>
> ```bash
> npx -y github:xerxesduane/ministry-newsletters --http --host 0.0.0.0 --token "a-long-random-secret"
> ```
>
> Epistle refuses to bind beyond your computer without one, because that port can read your
> partner list and send email as you. Think hard before opening it: for missionaries in
> restricted-access countries, a reachable supporter list is a real risk, not a theoretical one.

### Running from source instead

```bash
git clone https://github.com/xerxesduane/ministry-newsletters.git
cd ministry-newsletters
npm install        # also builds
npm test           # 126 tests
node dist/src/index.js --help
```

<sub>The git repository is still called `ministry-newsletters`; the tool it contains is Epistle.</sub>

Then ask your AI to run `stello_status` — it reports what it can see and what is missing.

### Letting it see your Stello contacts

If your partners are already in Stello, import them so the handoff file addresses the contacts
Stello already has instead of duplicating them:

1. In Stello: **Settings → Backup → "Back up database now"**
2. Ask your assistant to run `partners_import_from_stello`

This reads Stello's backup file. It is read-only — nothing is written back.

If Stello keeps its files somewhere unusual, set `STELLO_FILES_DIR` (or point
`STELLO_BACKUP_FILE` straight at a `database.json`).

### Optional: direct email

Only needed if you want to send without Stello. Add to the server's `env`:

| Variable | Meaning |
|---|---|
| `EPISTLE_SMTP_HOST` | e.g. `smtp.gmail.com` |
| `EPISTLE_SMTP_PORT` | `587` for STARTTLS, `465` for TLS (default `587`) |
| `EPISTLE_SMTP_USER` | mailbox to send from |
| `EPISTLE_SMTP_PASS` | an **app password**, not your account password |
| `EPISTLE_SMTP_FROM` | address partners see (defaults to the user) |
| `EPISTLE_SMTP_FROM_NAME` | e.g. `The Rock City Church` |
| `EPISTLE_SMTP_REPLY_TO` | where replies go (optional) |

Credentials live in your assistant's config or your shell, and are never written into Epistle's own files.

---

## Using it

Just talk to your assistant. A real session looks like:

> **"Write our October partner update. We had 43 baptisms, the building fund is at $6,100 of
> $10,000, and Pastor James is heading to Kenya in November. Send it to the monthly supporters."**

It will create the newsletter, write the sections, add a chart for the building fund, set the
audience, and render you a preview to read before anything happens.

### The flow

| Step | Tool |
|---|---|
| Check the setup | `stello_status` |
| Bring in partners | `partners_import_from_stello`, `partners_import_csv`, `partners_add` |
| Start writing | `newsletter_create` |
| Add content | `newsletter_add_text`, `_add_images`, `_add_video`, `_add_chart`, `_add_html` |
| Choose recipients | `newsletter_set_audience` |
| **Read it first** | `newsletter_preview` |
| Deliver via Stello | `stello_export` → import in Stello → review → Send |
| Or deliver directly | `email_send_test`, then `email_send` |

### Writing

Text sections take Markdown, converted to exactly the HTML Stello's editor produces — so a draft
stays fully editable in Stello after import:

```
## Thank you

Dear {{contact_hello}}, your partnership made this month possible.

- 43 people baptised
- The Kenya team leaves 12 November
- [Give toward the building fund](therockcitychurch.com/give)

> "The harvest is plentiful but the workers are few."

^ You are receiving this because you partner with our ministry.
```

`{{contact_hello}}` and friends are personalised per recipient at send time. Run
`newsletter_variables` for the full list — the useful ones are `{{contact_hello}}` (their first
name), `{{contact_name}}`, `{{sender_name}}` and `{{msg_title}}`.

Supported: `## heading` (Stello only has one heading level), `**bold**`, `*italic*`,
`==highlight==`, `[links](url)`, `- ` bullets, `1. ` numbers, `> ` quotes, `---` rules, and `^ `
for a small note line.

---

## Which delivery route?

|  | Through Stello | Direct email |
|---|---|---|
| Encryption | End-to-end | None — a normal email |
| Expiry / retraction | Yes | No, it's in their inbox forever |
| Read counts, reactions, replies | Yes | No |
| Photos and charts | Yes | Yes |
| Extra steps | Import + press Send | None |
| Needs Stello installed | Yes | No |

**Use Stello** when the update carries anything you would not want indexed or forwarded — and for
ministry newsletters that is usually the case: partner names, financial figures, security
situations for workers in sensitive countries.

**Use direct email** for a simple public update, or before Stello is set up.

Ask your assistant to run `stello_how_it_works` for the long version.

---

## Safety rails

Sending to a partner list is not undoable, so Epistle is built to fail closed.

- **`newsletter_preview` before anything goes out.** Renders exactly what a partner will see.
- **`email_send` defaults to `dry_run: true`** — it lists who *would* receive it and sends nothing.
- **`email_send` demands the recipient count.** You pass `confirm_recipients`; if the audience has
  changed since you reviewed it, the send is refused and reports both numbers. A list that grew
  between review and send never gets mailed by accident.
- **`email_send_test`** delivers one copy to your own inbox first.
- **The Stello route cannot send at all.** It writes a file; you press Send.
- **Importing into Stello cannot destroy anything** — `add()`-only, verified by tests that replay
  Stello's own import logic.
- **HTML is rebuilt, never passed through.** Stello's displayer renders section HTML with `v-html`
  and no sanitisation of its own, so anything reaching a section reaches a recipient's browser
  intact. Everything here is either built from Markdown or rebuilt from a strict whitelist matching
  Stello's TipTap schema; scripts, styles, event handlers, `javascript:` and `data:` URLs, and
  unknown tags are all dropped.

---

## Tool reference

**Writing** — `newsletter_create`, `newsletter_list`, `newsletter_get`, `newsletter_add_text`,
`newsletter_add_html`, `newsletter_add_images`, `newsletter_add_video`, `newsletter_add_chart`,
`newsletter_edit_text`, `newsletter_move_section`, `newsletter_remove_section`,
`newsletter_set_options`, `newsletter_preview`, `newsletter_delete`, `newsletter_variables`

**Partners** — `partners_add`, `partners_list`, `partners_update`, `partners_remove`,
`partners_import_csv`, `partners_export_csv`, `partners_import_from_stello`, `group_create`,
`group_list`, `group_set_members`, `group_delete`, `newsletter_set_audience`

**Stello** — `stello_status`, `stello_export`, `stello_how_it_works`

**Direct email** — `email_check`, `email_send_test`, `email_send`

---

## Where things are stored

```
~/.epistle/
├── store.json                       newsletters, partners, groups
└── exports/
    ├── preview-<id>.html            open in a browser
    ├── stello-import-<id>.json      import in Stello
    └── <group>.csv
```

Override with `EPISTLE_DIR`. `store.json` is plain JSON — readable, and repairable by
hand if it ever needs to be. Saves are atomic (temp file + rename), so an interrupted write cannot
truncate your partner list.

Images are copied into Stello's `Internal Files/` folder, which is where Stello reads image data
from. Stello never reuses a name there, so copying a file in is additive.

---

## Known limits

- **"Never expires" can't travel in the handoff file.** Stello stores it as `Infinity`, which JSON
  has no value for. The draft inherits your account default instead; set it on the draft in Stello.
  The tool warns rather than silently substituting something else.
- **Image sections need Stello installed** — the file has to go in Stello's folder. Text, video and
  chart sections work without it.
- **One section per row.** Stello can place two sections side by side; pair them by dragging in
  Stello after import.
- **The import step is manual.** Automating it would mean writing into Chromium's LevelDB under a
  running Electron app — unsafe — or forking Stello to add a control channel.
- **File attachments and sub-pages aren't exposed yet.** Stello supports both; add them in Stello.

---

## Development

```bash
npm run build       # compile
npm run typecheck   # tsc --noEmit
npm test            # build + run all 126 tests
```

```
src/
├── index.ts          entry — chooses stdio or HTTP
├── cli.ts            argument parsing and --help
├── http.ts           HTTP transport, for agents that connect by URL
├── server.ts         tool registration
├── config.ts         paths, Stello discovery, SMTP config
├── store.ts          persistence + audience resolution
├── types.ts          domain types
├── stello/
│   ├── records.ts    Stello's record types, mirrored from upstream
│   ├── ids.ts        generate_token(), matching Stello's format
│   ├── html.ts       Markdown → Stello HTML, and the sanitiser
│   ├── convert.ts    newsletters → Stello records
│   ├── export.ts     builds the backup envelope
│   ├── import.ts     reads Stello's backup (read-only)
│   ├── blobstore.ts  copies images into Stello's folder
│   └── preview.ts    HTML + plain-text rendering
├── email/send.ts     direct delivery, with the send guards
└── tools/            the MCP tool surface
```

`tests/export.test.ts` contains `replay_stello_import`, a reimplementation of Stello's
`import_database()` using the same converters and the same `add()` semantics. Our output is run
through it to prove the file imports cleanly and that an import can only add.

### Publishing a new version

```bash
npm version patch          # or minor / major — also updates src/version.ts by hand
npm publish                # prepublishOnly builds and runs the tests first
git push --follow-tags
```

`src/version.ts` is the single source of truth for what the server reports over MCP; keep it in
step with `package.json`.

### Keeping up with Stello

These files mirror upstream and should be rechecked when Stello changes:

| Here | Upstream |
|---|---|
| `src/stello/records.ts` | `app/src/services/database/types.ts` |
| `src/stello/export.ts` | `app/src/services/backup/database.ts` |
| `src/stello/html.ts` | `app/src/components/global/AppHtml.vue` (TipTap schema) |
| `src/stello/ids.ts` | `app/src/services/utils/crypt.ts` + `utils/coding.ts` |
| `src/store.ts` (`resolve_audience`) | `app/src/services/misc/recipients.ts` |
| `src/stello/blobstore.ts` | `app/src/services/database/blobstore.ts` |
| `src/config.ts` (path discovery) | `electron/src/utils/paths.ts` |

Verified against Stello at database version 21, backup format version 1.

---

## Licence

Epistle is MIT. Stello itself is MIT-0 from [Gracious Tech](https://gracious.tech); Epistle is an
independent tool that interoperates with it and is not affiliated with or endorsed by them.
