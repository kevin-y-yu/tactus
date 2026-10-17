# Tactus user guide

Tactus is a personal, single-user auto-scheduling planner that runs in the browser. Projects (with ordered stages),
tasks and recurring tasks are placed automatically into free time inside your schedules (your work hours, or any other
weekly hours you define), around events read from your linked calendars. Tactus reschedules after every change, every 15 minutes, and when you click "Reschedule" in the header, shows
the plan in week, day and agenda views, and flags work that will miss a deadline.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite` module).
- No build step and no other tools. The only npm dependencies are `express` and `ical.js`.

## Run

```sh
./run.sh           # check Node >= 22.13, install deps if needed, back up the DB, start the server
./run.sh test      # node --test (27 test files)
./run.sh backup    # copy the DB to data/backups/tactus-<timestamp>.db
```

Open http://localhost:3200 in a browser (`PORT=3300 ./run.sh` to change the port). Data is stored in `data/tactus.db` (SQLite) unless
`DB_PATH` says otherwise. Every `./run.sh` start copies the existing DB to `data/backups/` first, which matters because v2's
schedule migration is one-way. The plain `npm ci && npm start` and `npm test` still work.

Node prints an `ExperimentalWarning` for `node:sqlite` at startup. It is expected and harmless; no flags are needed.

Upgrading from an earlier version needs no manual step: on first start the database is migrated in place, and your old
work hours become the default schedule "Work". Back up `data/` first if you want to be able to go back.

## Configuration

Set environment variables, or copy `.env.example` to `.env` (loaded automatically at startup; real environment
variables win).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3200` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. A non-loopback host without `AUTH_TOKEN` logs a startup warning. |
| `DATA_DIR` | `<repo>/data` | Runtime data directory |
| `DB_PATH` | `$DATA_DIR/tactus.db` | SQLite database file |
| `AUTH_TOKEN` | unset (auth off) | Shared token. When set, every `/api/*` route except `/api/health` and `/api/auth/*` requires it (as `Authorization: Bearer <token>` or via the login page's session cookie). Static files stay public. Must be at least 24 characters (generate one with `openssl rand -hex 24`); a shorter token stops the server at startup. |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy (for example Heroku) so secure cookies work |

Scheduling settings are edited on the Settings page, in four sections: **Work hours & schedules**
(`#/settings/schedules`), **Calendars** (`#/settings/calendars`: linked calendars, all-day events, refresh interval),
**Scheduling rules** (`#/settings/rules`: minimum block length, breaks, meeting buffer, planning horizon, hard-deadline
safety margin) and **General** (`#/settings/general`: timezone, week start, 24-hour clock). Scheduling slots are 15 minutes.

## Using Tactus

- **Views**: Week (`#/week`), Day (`#/day`), Agenda (`#/agenda`), Projects (`#/projects`, task editor at
  `#/task/<id>`), Recurring (`#/recurring`, editor at `#/recurring?edit=<id>` or `#/recurring?edit=new`), Settings
  (`#/settings/<section>`). The risk panel at the side lists hard deadlines at risk, past soft deadlines, unscheduled
  work and tight tasks.
- **New task**: the header's "+ Task" opens the editor over the current view; Esc or closing it returns to that view
  unchanged. In Projects the new task starts in the project and stage you last clicked in; in Agenda it starts in the
  project you filtered by.
- **Deadlines**: a deadline with a date but no time means the end of that day (23:59 in your timezone).
- **Drag and resize**: drag a future block to pin it at a new time; drag its bottom edge to resize a task block. On
  touch screens, tap a block first to select it, then drag. Esc cancels a drag. The block popover's "Move…" is the
  keyboard alternative.
- **Moving tasks between projects**: in Projects, drag a task by its grip (⠿) onto another stage, a "No stage" group or
  another project's card header, or use the task's "Move…" button to pick the target from a list. A toast confirms the
  move and offers "Undo". Stage headers have a grip too, for reordering stages within their project.
- **Agenda keyboard**: `j` / `k` move the selection, `x` toggles done (for a split task it opens a menu: "Whole task
  done" or "This part only"), `Enter` opens the selected item.
- **Timezone**: everything is shown in the timezone set in Settings. A banner offers to switch when your browser's
  timezone differs.

## Recurring tasks

- **Splitting**: a recurring occurrence is placed like a task: it can be split across free gaps. Each recurring task has an optional "Minimum block" (15-240 minutes); blank uses the default minimum block from Settings → Scheduling rules. A split occurrence is marked done as a whole.
- **Weekly total on any day**: choose Weekly and tick no weekdays. The duration is then a total for each week (up to 40 hours), placed on any day of that week, earliest free time first. The week starts on the day set in Settings → General.

## Projects, standalone tasks and blocked-by

- **Layout**: each project is a full-width card, stacked vertically. The ▾ button at the left of a card header (and of each stage header) collapses it to one line with its open-task count; collapsed state is remembered in this browser. You can still drop a task onto a collapsed card's header to move it there.
- **Projects are optional.** A task with no project is standalone and appears in the "No project" card on the Projects page. New tasks start with no project unless you create them from a project or filter the Agenda by one. (Older databases lose the "Inbox" project when upgraded: its tasks become standalone.)
- **Blocked by tasks**: inside a project, a task can be blocked by other open tasks of the same project (task editor → "Blocked by tasks"). It is only scheduled after all of them are finished. The blocker's editor shows what it is blocking. Circular links, links to tasks in other projects, and links against stage order are refused. A task can also block other tasks of its project ("Blocking tasks"), which is the same link seen from the other side. Moving a task to another project removes its links. Stages still order tasks as before.
- **Blocked by calendar events**: any task, with or without a project, can start only after chosen calendar events end ("Starts after calendar events" in the task editor; "Choose from calendar…" opens a condensed week calendar where you click events). Events do not need a project. If the event is removed from its calendar, the link is shown as "no longer in calendar" and stops blocking.
- **Blocking calendar events**: a task can also be set to finish before chosen events ("Must finish before calendar events"). The earliest such event's start acts as a hard deadline for the task, or its own deadline if that is earlier. A removed event stops applying.

- **Duration units**: task and recurring durations are entered in hours by default (decimals allowed, e.g. 1.5) with a hours/minutes toggle that is remembered in this browser. Values round to the nearest 15 minutes (minimum 15).
- **Stage deadlines as defaults**: a new task takes its stage's deadline and type (hard/soft) in the editor, and follows the stage if you change it, until you edit the deadline yourself. Projects have no deadline of their own; set deadlines on stages.
- **On the calendar**, a task in a project shows as "Project: Task".

## Lunch and the 24-hour clock

- **Lunch** (Settings → Scheduling rules → Lunch): set a lunch length (0 = none) and the earliest start and latest end. Each working day gets one lunch in the earliest free time inside that window and your default schedule's hours, around meetings. It is placed before recurring tasks and tasks, shows on the calendar, and counts as a break: work on either side is not one continuous stretch for the break rule. A lunch that has already started stays where it is. If you used to plan lunch as a task or a gap in your hours, delete that and use this.
- **24-hour clock** (Settings → General): when on, time fields are text boxes that take `13:00` (also `1300` or `9:30`) instead of the browser's 1:00 PM style. Calendar and list times are always shown in 24-hour form.

## Schedules

A schedule is a named set of weekly hours, for example "Work" (weekdays 09:00–17:30) and "Evenings" (every day
18:00–21:00). Tactus places a task only inside the hours of its schedule. Manage schedules under Settings → Work hours &
schedules (`#/settings/schedules`, also reachable from "Edit hours" in the calendar toolbar). Each schedule is a card with
a name, a colour, one row per weekday of 15-minute ranges ("+ Add range", "Remove", and "Copy to weekdays" to copy that
day to Monday–Friday) and a Save button. "+ New schedule" starts from a copy of the default schedule's hours.

- **The default schedule** (the card with the "Default" badge; a new or upgraded database starts with one called
  "Work") is fully editable: you can rename it, change its colour and change its hours. The only thing you cannot do is
  delete it. To delete it, first use "Make default" on another schedule.
- **Which schedule a task uses**: the task's own "Schedule" choice in the task editor; otherwise its project's "Schedule"
  (on the project card); otherwise the default schedule. Recurring tasks have the same "Schedule" choice, falling back to
  their project's and then the default. A recurring task with a preferred time window ignores schedules and uses its
  window.
- **Meeting buffer**: Tactus leaves a gap after each meeting (default 15 minutes, Settings → Scheduling rules), not before it. Meetings no longer than twice the buffer get no gap.
- Calendar events, breaks and the meeting buffer apply to every schedule, and work from different schedules never
  overlaps: there is one timeline.
- Deleting a schedule moves its tasks, projects and recurring tasks to their fallback; the confirmation says how many
  are affected and which schedule they move to.
- The calendar toolbar's "Hours:" select shades the hours of all schedules, or of one schedule in its colour.

## Linking a calendar

Tactus reads your calendars through their ICS (iCal) links so it never schedules over your meetings. It is read-only:
it never creates, changes or deletes anything in your calendar. Go to Settings → Calendars (`#/settings/calendars`),
click "Link a calendar", pick your provider and follow the steps shown:

- **Google Calendar**: on a computer, open Google Calendar → Settings (gear) → Settings. Under "Settings for my
  calendars" pick the calendar → "Integrate calendar", and copy "Secret address in iCal format" (it ends in `.ics`). Keep
  it private. Google can take several hours to show changes.
- **Apple iCloud**: in the Calendar app (Mac) or at icloud.com/calendar, click the share icon next to the calendar, turn
  on "Public Calendar" and copy the link (it starts with `webcal://`). Anyone with the link can read the calendar.
- **Outlook / Microsoft 365**: in Outlook on the web, Settings (gear) → Calendar → Shared calendars → "Publish a
  calendar". Pick the calendar and "Can view all details", click Publish, then copy the ICS link. Work accounts may have
  publishing turned off by IT.
- **Other**: any `https://` or `webcal://` link that ends in `.ics`.

Tactus re-fetches calendars automatically every "Calendar refresh interval" minutes (default 15), when you click "Refresh calendars" in the header, and when you add a new task (calendars last fetched over a minute ago, waiting at most 5 seconds).

Paste the link, give it a name and colour, and leave "Block my time" on if its events should keep work away. A hint under
the link field catches common mistakes, such as a Google share link or an Outlook HTML link. After "Add calendar",
Tactus fetches the calendar once and shows "Linked. Found N events.", an amber warning if it found no events, or the
error with "Try another link" and "Remove". A link is never shown again after saving; only a redacted form is displayed,
and full links are never logged.

## Completed tasks stay on the calendar

Marking a task done keeps its blocks on the calendar, shown with a ✓, and counts them as done work. If the task's
not-yet-completed blocks would have finished more than 30 minutes from now, they are moved earlier, keep their lengths
and are packed back to back so that the last one ends now. If they finish within 30 minutes, they stay where they are.
So a task that was planned for tomorrow and is finished today shows today, ending at the current time. Moved blocks may
overlap other items; no warning is shown. Recurring occurrences marked done follow the same rule. A task with no blocks
leaves nothing on the calendar. Reopening a task does not move its blocks back.

## Calendar zoom

The Week and Day views always draw the full day (00:00–24:00) and can always be scrolled. The toolbar toggle chooses the
zoom, and your choice is remembered in this browser:

- **Work hours** (default): the scale is chosen so that the schedule hours of the visible days (widened to include any
  block or event outside them, plus 30 minutes either side) fill the window height, and the view opens scrolled to the start of that range. Scroll up
  or down for earlier or later hours.
- **24 h**: the scale is chosen so that the whole day fits the window (on a very short window it still scrolls).

The scale stays within 32–160 pixels per hour in Work hours mode and 20–160 in 24 h mode. Resizing the window rescales
the grid and keeps the time at the top in place.

## Hosting

`Procfile` (`web: node server.js`) runs Tactus on a platform such as Heroku. When hosting, set `HOST=0.0.0.0`,
set a long random `AUTH_TOKEN`, and set `TRUST_PROXY=1` behind the platform's proxy.

- **SQLite on Heroku is ephemeral**: the dyno filesystem is reset on every restart and deploy, so all data is lost.
  A Postgres adapter is backlog item BL-1; until then, host only where `DATA_DIR` is on persistent disk.
- `AUTH_TOKEN` must be at least 24 characters, or the server refuses to start. Generate one with
  `openssl rand -hex 24`. The login endpoint has no rate limit, so a long random token is what protects it.

## Limitations

- Schedule hours cannot cross midnight (backlog item BL-6). Use `24:00` as the end of a day and start the next day at `00:00`.
- Monthly recurrences on day 29–31 clamp to the last day of shorter months (for example the 31st becomes 30 April).
- Recurring occurrences are placed before tasks, but they follow the break rule, so a long one is cut into runs with breaks.
- Calendar feeds are read-only; Tactus never writes to your calendar.

## Licences

Tactus is released under the MIT licence (`LICENSE`). Third-party notices are in `THIRD_PARTY_NOTICES.md`. `ical.js` is MPL-2.0 and is used unmodified as an npm dependency; never patch files
inside `node_modules/ical.js`.
- Changing a stage deadline or type also sets it on the stage's open tasks. Extending a stage's deadline asks whether later stages shift by the same amount or are resized to still finish by the original final deadline (projects have no deadline of their own).
- Low-priority recurring tasks can be marked "May be dropped to meet a deadline": when tasks would otherwise miss a deadline, the scheduler gives up those occurrences (earliest first) while it helps. Dropped ones are listed in `/api/status` under `dropped`.
- Calendar blocks have a small circle that marks the task (or recurring occurrence) done in one click.
- A weekly recurring task with no weekdays (a per-week budget) is spread evenly over the days that have free time, rather than packed into the first day.
- "Blocked by tasks" and "Blocking tasks" in the task editor are collapsed lists (click to expand, click a task to tick it). They offer only tasks in the same stage; a task with no stage can link to any task in its project.

## Contact

Kevin Yu. Issues and suggestions welcome.
