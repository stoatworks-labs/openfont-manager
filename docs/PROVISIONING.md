# Provisioning a fleet of machines

The problem this solves: six presentation laptops and a show file that names
Poppins, Montserrat and a client's brand font. Somebody has to put those on
every machine, and remember to do it again when the next show adds Lora.

OpenFont Manager turns that into one folder. Each machine runs the desktop
app at login; the app reads that folder; whatever is in it gets installed.

## One-time setup, per machine

1. Install the desktop app and open it.
2. **Automatic provisioning** tab:
   - Tick **Start at login**. The app registers itself as a login item
     (a LaunchAgent on macOS, a Run key on Windows, an autostart `.desktop`
     entry on Linux) that launches it hidden in the tray with `--background`.
   - Tick **Sync when the app starts**.
   - Pick **Then repeat** — every hour is a good default for a machine that
     stays on; *only at startup* for one that is booted for each show.
3. Add where the fonts come from. Either or both:
   - **Watched folder** — a local folder. Drop `.csv`, `.xml` or `.txt` lists
     in it. Handy for a machine that is not always on the network: sync the
     folder with whatever you already use (Dropbox, Nextcloud client, a
     script).
   - **Network source** — *Add folder or mounted share…* and choose the
     mount point of an SMB, NFS or WebDAV share the OS mounts at login
     (`/Volumes/fonts` on macOS, a mapped drive or `\\nas\fonts` on Windows,
     `/mnt/fonts` on Linux). Or *Add WebDAV URL…* to talk to a WebDAV server
     directly — no mount needed, and the password goes into the system
     keychain (on Linux, a `secrets.json` next to the settings, mode 0600).
   - Press **Test**. It reports how many font files and lists it can see.
     "is not a readable folder" usually means the share is not mounted yet.
4. Press **Sync now** once to prove it, and read the report at the bottom.

## What goes on the share

Two kinds of thing, anywhere in the tree (six levels deep for fonts, four
for lists):

- **Font files** — `.ttf`, `.otf`, `.ttc`. Installed as they are, under
  their own filename. Use this for fonts you already have the files for,
  including ones that are not on Google Fonts (a licensed brand font you
  are entitled to deploy, say).
- **Lists** — `.csv`, `.xml`, `.txt` naming families to fetch from Google
  Fonts or Fontsource. See the README for the formats and
  [`../examples/`](../examples/) for one of each. A list is processed once
  and remembered by its content hash; edit it and it is processed again.
  Lists that name families no catalogue has are logged and retried on
  every pass (cheap — nothing is downloaded twice).

Build a list in the browser or desktop app: add families to the checkout,
then **Export CSV** or **Export XML**.

## What happens on a pass

1. Every list in the watched folder and on every enabled source is read.
   New or changed ones are resolved against the catalogue; the files for
   each family that are not already in the font folder are downloaded (four
   at a time, with retries and a mirror) and installed.
2. Every font file on every enabled source is compared by filename against
   the font folder; the missing ones are copied in and registered with the
   OS.
3. The report goes to the log (`sync.log`, shown in the panel) and, in the
   app, to the *Last sync* section.

Nothing is ever overwritten and nothing is ever removed. To ship a new
version of a font, give the file a new name. To take a font off the
machines, remove it from their font folders yourself — a sync that deletes
fonts is a sync that one day empties a laptop before a show.

## Things to know

- **The share must be mounted before the pass.** On macOS, a share opened
  from Finder is remounted at login only if it is in *Login Items*; a
  WebDAV URL source avoids the question entirely. The startup pass waits
  eight seconds after launch for exactly this reason.
- **macOS AppleDouble files** (`._Foo.ttf`, which macOS leaves on SMB
  shares) are skipped, as is anything whose name starts with a dot.
- **A file that is not a font is refused**, whatever its extension. Every
  file is checked for a TrueType/OpenType signature before it is written to
  the font folder — a download that came back as an error page cannot end
  up installed under a font's name.
- **Already-open applications** may need restarting before they see new
  fonts. On Windows, Chromium-based browsers do not reliably see per-user
  fonts at all; Office does.
- **Per-user, not system-wide.** Fonts go to `~/Library/Fonts`,
  `%LOCALAPPDATA%\Microsoft\Windows\Fonts` or `~/.local/share/fonts`, so no
  administrator password is needed and a machine with several accounts
  needs the app running in each.
- **Headless:** `openfont-manager --sync` runs one pass and exits 1 if
  anything failed, for a cron job, a login hook or a deployment script.
  `openfont-manager --install list.csv` installs one list without touching
  the watched-folder state.
