# Quak GitHub Action

Hear your CI on your Sonos speakers: a voice when the deploy is out, a sound when the build breaks, a fanfare for the
release. One step in your workflow through the [Quak API](https://quak.party), nothing to install.

The full guide with recipes is on [quak.party/apps/github](https://quak.party/apps/github).

## Set it up

1. In the [Quak web app](https://quak.party), switch to the workspace whose speakers should play and make a key under
   **Settings → API keys**. A key belongs to one workspace, the access `play` is enough.
2. Add it to your repository under **Settings → Secrets and variables → Actions** as `QUAK_API_KEY`.
3. Add a step where it should be heard:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: ./deploy.sh

      - name: Announce it
        uses: quakparty/quak-github-action@v1
        with:
          api-key: ${{ secrets.QUAK_API_KEY }}
          type: text
          text: "Deployed to production."
```

Everything you leave out comes from your workspace's playback defaults: speakers, voice, volume, quiet hours.

## Text, sound or clip

`type` says what plays, the input of the same name says which.

```yaml
# a text, spoken with your default voice
- uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: text
    text: "The nightly backup is done."

# a built-in sound, by its slug
- uses: quakparty/quak-github-action@v1
  if: failure()
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: sound
    sound: alarm

# one of your own clips, by its slug
- uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: clip
    clip: release-fanfare
```

Put texts in quotes. YAML reads `: ` and ` #` on its own, so `Deployed: v1.2` without quotes breaks the workflow and
everything after a `#` goes missing. Slugs need no quotes.

## Where and how loud

`to` takes speaker slugs, separated by commas: rooms, groups, locations or `all`. Spaces around the commas don't
matter. A YAML list (`to: [office, kitchen]`) doesn't work, the inputs of an action are text.

```yaml
- uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: text
    text: "Release ${{ github.event.release.tag_name }} is live."
    to: office, kitchen
    volume: 30
    volumes: '{"kitchen": 50}'
    intro: clip:release-fanfare
```

## Effects and processing

Quak mixes intro, outro, gap, voice effect and ambience into the audio on its side:

| type            | mixed                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| `text`, `file`  | always                                                                                   |
| `sound`, `clip` | only with `process: true` (2 credits instead of 1). By default they play as they are.    |
| `url`           | by default. With `process: false` Sonos fetches the file itself (a public MP3 on https). |

Without mixing, these inputs have no effect. The action then says so with a warning in the log.

```yaml
- uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: sound
    sound: alarm
    process: true
    intro: quakquak
    effect: echo
```

The effects and ambiences are listed on [quak.party/apps/github](https://quak.party/apps/github#effects) and by
`GET /v1/effects`.

## File and URL

```yaml
steps:
  - uses: actions/checkout@v7 # the file has to be on the runner
  - uses: quakparty/quak-github-action@v1
    with:
      api-key: ${{ secrets.QUAK_API_KEY }}
      type: file
      file: audio/standup.mp3 # relative to the workspace, max. 10 MB and 3 minutes

  - uses: quakparty/quak-github-action@v1
    with:
      api-key: ${{ secrets.QUAK_API_KEY }}
      type: url
      url: https://example.com/doorbell.mp3
```

## What the log shows

One line per play, and annotations only when there is something to look at:

```
Quak: sound "alarm" sent to Office and Kitchen (1 credit, 248 left).
```

- **Skipped** (quiet hours, or every speaker busy with a play of higher priority): a notice, the step passes.
- **Some speakers failed**, others play: a warning, the step passes.
- **Errors** show as an error annotation with one line: the message, the input it is about, a hint where one helps,
  the HTTP status, the error code and the request ID, e.g.
  `Invalid API key. Check the secret QUAK_API_KEY: the key is unknown or was deleted. [HTTP 401, ERROR_INVALID_API_KEY] Request ID: …`.
- **Invalid inputs** are reported before any request, all problems at once.

The key is masked. Texts and URLs are never logged: a text shows as `text (34 characters)`. The play ID is in the
output `play-id` and, with
[debug logging](https://docs.github.com/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging),
in the log.

## Failures, forks and skipped plays

An announcement never breaks your run. When it fails, the error shows up as an annotation on the run's summary page
and in the log, and the step stays green. Want a red step instead, to notice right away when something's off, like a deleted key, a wrong input or Quak not
answering? Set `fail-on-error: true`:

```yaml
- uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: text
    text: "Checks passed."
    fail-on-error: true
```

- The step ends when Quak has taken the play, it doesn't wait until the speakers are done.
- Nothing is retried, so nothing plays twice. When Quak doesn't answer within 30 seconds the action gives up, and the
  play may have gone out anyway.
- Pull requests from forks and Dependabot runs get no secrets. Without a key there, the action plays nothing and
  leaves a warning, even with `fail-on-error: true`. Never switch to `pull_request_target` for it.
- A play skipped in quiet hours or because the speakers are busy is no error: a notice, `status` is `SKIPPED`.

## Inputs

Only `api-key`, `type` and the input of the type are required. Everything else comes from the workspace's defaults
when it is left out.

| Input                | For              | Value                                                                                    |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `api-key`            | all              | **Required.** A key with access `play`, from a secret.                                   |
| `type`               | all              | **Required.** `text`, `sound`, `clip`, `file` or `url`.                                  |
| `text`               | text             | The text, 1–1000 characters.                                                             |
| `sound`              | sound            | Slug of a built-in sound.                                                                |
| `clip`               | clip             | Slug of one of your clips.                                                               |
| `file`               | file             | Path on the runner, relative to the workspace or absolute. Max. 10 MB, 180 s.            |
| `url`                | url              | `http(s)` address of an audio file.                                                      |
| `to`                 | all              | Speaker slugs separated by commas: rooms, groups, locations or `all`.                    |
| `volume`             | all              | 1–100.                                                                                   |
| `volumes`            | all              | Per speaker, a JSON object: `'{"kitchen": 50}'`. The rest get `volume`.                  |
| `voice`              | text             | Voice slug.                                                                              |
| `language`           | text             | For voices that speak several languages, e.g. `en-US` or `de-DE`.                        |
| `intro`, `outro`     | mixed plays      | A sound slug, `clip:<slug>` for one of your clips, or `none`.                            |
| `gap`                | mixed plays      | Pause around intro and outro: 0–1000 ms in steps of 100.                                 |
| `effect`             | mixed plays      | Voice effect, e.g. `robot`, `megaphone`, `echo`, or `none`.                              |
| `effect-intensity`   | mixed plays      | `off`, `weak`, `medium` or `strong`.                                                     |
| `ambience`           | mixed plays      | Ambience behind the voice, e.g. `stadium`, `office`, `rain`, or `none`.                  |
| `ambience-intensity` | mixed plays      | `off`, `weak`, `medium` or `strong`.                                                     |
| `process`            | sound, clip, url | `true` or `false`, see [Effects and processing](#effects-and-processing).                |
| `skip-cache`         | mixed plays      | `true` makes the audio again instead of reusing it.                                      |
| `quiet-hours`        | all              | Overrides the workspace's: `none`, `22-7` or e.g. `su-th 22-7, fr-sa 23-9`.              |
| `priority`           | all              | `true` cuts into everything that plays, even a doorbell. For the urgent ones.            |
| `start-in`           | all              | Seconds until it plays, 0–60, decimals allowed.                                          |
| `preview`            | all              | `true` makes the audio without playing it, see `audio-url`. Still costs credits.         |
| `fail-on-error`      | all              | `true` fails the step when the announcement fails. Default `false`: the run stays green. |

Booleans are `true` or `false`.

## Outputs

| Output        | Value                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| `play-id`     | The play's ID.                                                                 |
| `status`      | As Quak took it: usually `PENDING`, or `SCHEDULED` with `start-in`, `SKIPPED`. |
| `skip-reason` | `QUIET_HOURS` or `BUSY` when skipped, else empty.                              |
| `audio-url`   | The audio, e.g. of a preview. Empty when there is none.                        |
| `credits`     | What the play cost.                                                            |
| `starts-at`   | When it plays, with `start-in` (ISO 8601), else empty.                         |

Pass outputs to a script through `env`, not straight into it:

```yaml
- id: quak
  uses: quakparty/quak-github-action@v1
  with:
    api-key: ${{ secrets.QUAK_API_KEY }}
    type: text
    text: "Build done."
- if: steps.quak.outputs.status == 'SKIPPED'
  env:
    REASON: ${{ steps.quak.outputs.skip-reason }}
  run: echo "Quak skipped it ($REASON)"
```

## Versions

`@v1` is a major tag and follows every `1.x` release. To pin one exactly, use the full commit SHA of a release. The
action needs no `permissions` and runs on Linux, macOS and Windows runners, also self-hosted ones that reach
`api.quak.party`.

## License

MIT
