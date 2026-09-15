# Epistle

An MCP server that lets Claude write your ministry newsletters and get them to your partners —
either through [Stello](https://stello.news) (encrypted, interactive, retractable) or as ordinary
email.

*ἐπιστολή — a letter sent to.* The apostolic letters were written to the churches and partners
who supported the work. That is what a ministry partner newsletter still is.

You describe the update; Claude writes it, shows you a preview, and hands it to Stello as a real
draft. **You review it and press Send.** Nothing reaches a partner without you seeing it first.

---

## Why it works this way

Stello is an Electron desktop app. Every newsletter lives in an IndexedDB database inside the app
on your computer, each copy is encrypted in the app before it leaves, and the invitation emails go
out through your own email account. There is no server and no API for an outside program to call.

There is, however, one supported door: Stello can **restore from a backup file**. Its importer
(`app/src/services/backup/database.ts`) adds each record with IndexedDB's `add()`, which refuses
a key that already exists. So an import can only ever **add** records — it cannot modify or delete
anything already in Stello.

This connector writes that file. It never touches Stello's database directly, never handles your
encryption keys, and never sends on your behalf through Stello.

```
  Claude ──▶ this MCP server ──▶ stello-import-<id>.json
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

The one thing the connector cannot do is press Send for you. For a newsletter going to real
supporters, that turns out to be the feature.

---

## Setup

Requires Node.js 20 or newer.

```bash
git clone https://github.com/xerxesduane/ministry-newsletters.git
cd ministry-newsletters
npm install        # also builds
npm test           # 107 tests, including 12 that drive the real server
```

<sub>The git repository is still called `ministry-newsletters`; the tool it contains is Epistle.</sub>

Add it to your MCP client. For Claude Code:

```bash
claude mcp add epistle -- node /absolute/path/to/ministry-newsletters/dist/src/index.js
```

Or by hand, in `claude_desktop_config.json` / `.mcp.json`:

```json
{
  "mcpServers": {
    "epistle": {
      "command": "node",
      "args": ["/absolute/path/to/ministry-newsletters/dist/src/index.js"]
    }
  }
}
```

Then ask Claude to run `stello_status` — it reports what it can see and what is missing.

### Letting it see your Stello contacts

If your partners are already in Stello, import them so the handoff file addresses the contacts
Stello already has instead of duplicating them:

1. In Stello: **Settings → Backup → "Back up database now"**
2. Ask Claude to run `partners_import_from_stello`

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

Credentials live in your MCP client's config and are never written into this connector's files.

---

## Using it

Just talk to Claude. A real session looks like:

> **"Write our October partner update. We had 43 baptisms, the building fund is at $6,100 of
> $10,000, and Pastor James is heading to Kenya in November. Send it to the monthly supporters."**

Claude will create the newsletter, write the sections, add a chart for the building fund, set the
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

Ask Claude to run `stello_how_it_works` for the long version.

---

## Safety rails

Sending to a partner list is not undoable, so the connector is built to fail closed.

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
npm test            # build + run all tests
```

```
src/
├── index.ts          entry (stdio transport)
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
