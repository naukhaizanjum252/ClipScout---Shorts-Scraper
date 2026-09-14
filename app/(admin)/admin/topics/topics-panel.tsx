"use client";

/**
 * /admin/topics — THE SCREEN WHERE SOMEBODY SAYS WHAT TO LOOK FOR.
 *
 * Luka, 2026-09-05: "we need to tell it what kinds of shorts to look for ...
 * not any random shorts with 500k+ views." This is the telling.
 *
 * WHY THE SEARCH TERMS ARE ON THE SCREEN AND NOT BEHIND AN "advanced" FOLD.
 * They are the whole mechanism. A topic named "Respect Moments" finds nothing
 * unless somebody types the words that actually appear on those clips, and the
 * shipped ones are a first guess written by a developer who has never run this
 * channel. Hiding them would present a translation as a fact, and the person
 * best placed to fix a bad term is the person looking at the results it
 * produced.
 *
 * WHAT THE PAGE REFUSES TO IMPLY. Every count of platforms at the top is the
 * deployment's real reach, not an aspiration: Facebook can never be searched by
 * anybody at any price, and TikTok and Instagram cannot until a vendor key
 * exists. A page that listed thirty topics against five platform logos would be
 * promising a hundred and fifty searches, of which thirty happen.
 */
import { useState, useTransition } from "react";

import { platformLabel } from "@/lib/platform/types";
import type { Topic } from "@/lib/shorts/topics";
import type { TopicChannel } from "@/lib/shorts/topic-channels";

import {
  CHANNEL_FIELD,
  CHANNEL_HINT,
  CHANNEL_PLATFORMS,
  FIELD,
  termsToText,
  type ChannelPlatform,
  type ChannelsByTopic,
  type TopicActionResult,
  type TopicsView,
} from "./view";

export interface TopicsPanelProps extends TopicsView {
  readonly channels: ChannelsByTopic;
  readonly addTopic: (form: FormData) => Promise<TopicActionResult>;
  readonly setTopicTerms: (form: FormData) => Promise<TopicActionResult>;
  readonly setTopicActive: (form: FormData) => Promise<TopicActionResult>;
  readonly restorePlanTopics: () => Promise<TopicActionResult>;
  readonly addTopicChannel: (form: FormData) => Promise<TopicActionResult>;
  readonly setTopicChannelActive: (form: FormData) => Promise<TopicActionResult>;
  readonly removeTopicChannel: (form: FormData) => Promise<TopicActionResult>;
}

export function TopicsPanel(props: TopicsPanelProps) {
  const { topics, explanation, readOnlyReason, reach } = props;
  const [result, setResult] = useState<TopicActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const editable = readOnlyReason === null;
  const active = topics.filter((t) => t.active);
  const searching = reach.filter((r) => r.canSearch);

  // A LOCAL FILTER over the topic list below. Browser-only state: it changes
  // what is shown, never what a run does. Matches a topic's name or any of its
  // search terms, so "nba" finds the NBA topic and "dunk" finds whichever
  // topic searches for it.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleTopics =
    q === ""
      ? topics
      : topics.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.terms.some((term) => term.toLowerCase().includes(q)),
        );

  /**
   * Every button on this page goes through here.
   *
   * The result is REPLACED rather than appended, so the message on screen is
   * always about the last thing pressed. A log of outcomes would let somebody
   * read a success from two clicks ago as the answer to the click that just
   * failed.
   */
  function run(work: () => Promise<TopicActionResult>) {
    startTransition(async () => {
      setResult(await work());
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel-title">What this run will search for</h2>

        <p className="note">{explanation}</p>

        <div className="figures">
          <div className="figure">
            <span className="v num">{active.length}</span>
            <span className="k">topics switched on</span>
          </div>
          <div className="figure">
            <span className={`v num ${searching.length === 0 ? "attention" : ""}`}>
              {searching.length} of {reach.length}
            </span>
            <span className="k">platforms that can be searched</span>
          </div>
        </div>

        {/* THE REACH, PER PLATFORM, IN THE ADAPTER'S OWN WORDS. Rendered whether
            or not it is good news: an operator looking at an empty Facebook
            group has to be able to tell "nothing was found" from "nothing was
            looked for, and nothing ever can be". */}
        <ul className="steps">
          {reach.map((row) => (
            <li key={row.platform}>
              <strong>{row.label}</strong>{" "}
              <span className={row.canSearch ? "state state-ok" : "state state-warn"}>
                <span className="state-mark" aria-hidden="true" />
                {row.canSearch ? "will search" : "will not search"}
              </span>
              {row.reason ? <div className="note">{row.reason}</div> : null}
            </li>
          ))}
        </ul>

        {active.length === 0 ? (
          <p className="notice">
            <strong>No topics are switched on.</strong> A run with no topics reads whatever is
            biggest on each platform rather than the kinds of clip this deployment is for — which
            is the behaviour topics were added to replace. Switch one on below, or add one.
          </p>
        ) : null}
      </section>

      {result ? (
        <p className={result.ok ? "field-ok" : "field-error"} role="status">
          {result.message}
        </p>
      ) : null}

      {readOnlyReason ? <p className="notice">{readOnlyReason}</p> : null}

      {editable ? (
        <section className="panel">
          <h2 className="panel-title">Add a topic</h2>
          <form
            className="form-grid form-grid-2"
            action={(form) => run(() => props.addTopic(form))}
            // Reset AFTER the action has the data, so a failed add does not
            // also lose what was typed. React runs `action` before this.
            onSubmit={(event) => {
              const el = event.currentTarget;
              window.setTimeout(() => el.reset(), 0);
            }}
          >
            <label className="field">
              <span>Name</span>
              <input name={FIELD.name} type="text" maxLength={80} required placeholder="Shark Tank" />
              <span className="hint">What you would call this kind of clip.</span>
            </label>

            <label className="field">
              <span>Search terms, one per line</span>
              <textarea
                name={FIELD.terms}
                rows={4}
                required
                placeholder={"shark tank\nshark tank pitch\ndragons den"}
              />
              <span className="hint">
                The words that actually find it. Each line is searched separately and the results
                are merged, so several near-misses beat one perfect phrase. On YouTube each one is
                sent as <code>ytsearch:&lt;your words&gt; #shorts</code>.
              </span>
            </label>

            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Add topic"}
            </button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <div className="list-head">
          <h2>Topics</h2>
          {editable ? (
            <button
              className="btn btn-quiet btn-small"
              type="button"
              disabled={pending}
              onClick={() => run(() => props.restorePlanTopics())}
            >
              Add any missing plan topics
            </button>
          ) : null}
        </div>

        <div className="stack">
          {topics.length > 6 ? (
            <input
              type="search"
              className="input"
              placeholder="Search topics by name or term…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search topics"
              autoComplete="off"
            />
          ) : null}

          {topics.length === 0 ? (
            <p className="empty">
              No topics yet. Until there is at least one, a run has no subject and returns whatever
              crossed the view threshold on each platform.
            </p>
          ) : visibleTopics.length === 0 ? (
            <p className="empty">No topics match “{query}”. Clear the search to see them all.</p>
          ) : (
            <div className="stack">
              {visibleTopics.map((topic) => (
                <TopicRow
                  key={topic.slug}
                  topic={topic}
                  editable={editable}
                  pending={pending}
                  channels={props.channels[topic.slug] ?? []}
                  onSaveTerms={(form) => run(() => props.setTopicTerms(form))}
                  onToggle={(form) => run(() => props.setTopicActive(form))}
                  onAddChannel={(form) => run(() => props.addTopicChannel(form))}
                  onToggleChannel={(form) => run(() => props.setTopicChannelActive(form))}
                  onRemoveChannel={(form) => run(() => props.removeTopicChannel(form))}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function TopicRow({
  topic,
  editable,
  pending,
  channels,
  onSaveTerms,
  onToggle,
  onAddChannel,
  onToggleChannel,
  onRemoveChannel,
}: {
  readonly topic: Topic;
  readonly editable: boolean;
  readonly pending: boolean;
  readonly channels: readonly TopicChannel[];
  readonly onSaveTerms: (form: FormData) => void;
  readonly onToggle: (form: FormData) => void;
  readonly onAddChannel: (form: FormData) => void;
  readonly onToggleChannel: (form: FormData) => void;
  readonly onRemoveChannel: (form: FormData) => void;
}) {
  return (
    <details className="row-edit">
      <summary>
        <span className={topic.active ? "state state-ok" : "state state-idle"}>
          <span className="state-mark" aria-hidden="true" />
          {topic.active ? "on" : "off"}
        </span>{" "}
        <strong>{topic.name}</strong>{" "}
        <span className="dim">
          {topic.terms.length} term{topic.terms.length === 1 ? "" : "s"}
          {channels.some((c) => c.active)
            ? ` · ${channels.filter((c) => c.active).length} channel${
                channels.filter((c) => c.active).length === 1 ? "" : "s"
              }`
            : ""}
        </span>
      </summary>

      <div className="row-edit-panel stack">
        <p className="faint mono">{topic.terms.join(" · ")}</p>

        {topic.publishesTo ? (
          <p
            className="faint"
            title="A note carried over from the original plan. This tool only finds clips and links — it never uploads anywhere."
          >
            Plan note: clips for this niche were meant for {topic.publishesTo}. This tool doesn’t
            upload anywhere — it’s only a label, safe to ignore.
          </p>
        ) : null}

        {editable ? (
          <>
            <form className="form-grid" action={onSaveTerms}>
              <input type="hidden" name={FIELD.slug} value={topic.slug} />
              <label className="field">
                <span>Search terms, one per line</span>
                <textarea name={FIELD.terms} rows={4} defaultValue={termsToText(topic.terms)} />
              </label>
              <button className="btn btn-small" type="submit" disabled={pending}>
                Save terms
              </button>
            </form>

            <form action={onToggle}>
              <input type="hidden" name={FIELD.slug} value={topic.slug} />
              <input type="hidden" name={FIELD.active} value={topic.active ? "false" : "true"} />
              <button className="btn btn-quiet btn-small" type="submit" disabled={pending}>
                {topic.active ? "Switch off" : "Switch on"}
              </button>
              {/* Said next to the button rather than in a confirmation, because
                  it is reassurance and not a warning: nothing is destroyed, so
                  a modal asking "are you sure" would overstate the stakes. */}
              <span className="hint">
                {topic.active
                  ? "Stops it being searched for. Its terms and everything it has found are kept."
                  : "Puts it back into the next run."}
              </span>
            </form>

            <ChannelsEditor
              topicSlug={topic.slug}
              channels={channels}
              pending={pending}
              onAdd={onAddChannel}
              onToggle={onToggleChannel}
              onRemove={onRemoveChannel}
            />
          </>
        ) : null}
      </div>
    </details>
  );
}

/**
 * THE PER-TOPIC CHANNEL LIST, ON THE SAME ROW AS THE TERMS.
 *
 * Channels are the second way a topic is searched (the first is its keywords),
 * so they belong here beside them rather than on a screen of their own. Only the
 * three platforms that can enumerate a creator are offered; the add form's
 * placeholder says exactly what to paste for the chosen one, because the three
 * are genuinely different (a YouTube handle, an Instagram handle, a TikTok
 * sec_uid) and a wrong-shape value is a channel that silently returns nothing.
 * Auto-added rows are marked, so an operator can tell what the self-growing loop
 * chose from what they chose themselves.
 */
function ChannelsEditor({
  topicSlug,
  channels,
  pending,
  onAdd,
  onToggle,
  onRemove,
}: {
  readonly topicSlug: string;
  readonly channels: readonly TopicChannel[];
  readonly pending: boolean;
  readonly onAdd: (form: FormData) => void;
  readonly onToggle: (form: FormData) => void;
  readonly onRemove: (form: FormData) => void;
}) {
  const [platform, setPlatform] = useState<ChannelPlatform>("youtube");
  const present = CHANNEL_PLATFORMS.filter((p) => channels.some((c) => c.platform === p));

  return (
    <div className="channels-editor stack">
      <p className="panel-title">Channels searched with this topic</p>
      <p className="hint">
        As well as the keywords, a run reads these creators&rsquo; latest posts and files them under
        this topic. YouTube, Instagram and TikTok only — X and Facebook can&rsquo;t enumerate a
        creator.
      </p>

      {channels.length === 0 ? (
        <p className="faint">
          No channels yet. Add one below — or leave it: the tool grows this list from the channels
          that perform for this topic.
        </p>
      ) : (
        present.map((p) => (
          <div key={p} className="channels-group">
            <p className="channels-group-head mono">{platformLabel(p)}</p>
            <ul className="channels-list">
              {channels
                .filter((c) => c.platform === p)
                .map((c) => (
                  <li key={c.channel} className="channels-row" data-off={!c.active || undefined}>
                    <span className="mono channels-id" title={c.channel}>
                      {c.channel}
                    </span>
                    {c.source === "auto" ? (
                      <span className="channels-auto" title="Added automatically from what performs for this topic.">
                        auto
                      </span>
                    ) : null}
                    {!c.active ? <span className="channels-off">off</span> : null}
                    <form action={onToggle}>
                      <input type="hidden" name={CHANNEL_FIELD.topicSlug} value={topicSlug} />
                      <input type="hidden" name={CHANNEL_FIELD.platform} value={p} />
                      <input type="hidden" name={CHANNEL_FIELD.channel} value={c.channel} />
                      <input type="hidden" name={CHANNEL_FIELD.active} value={c.active ? "false" : "true"} />
                      <button type="submit" className="btn btn-quiet btn-small" disabled={pending}>
                        {c.active ? "Off" : "On"}
                      </button>
                    </form>
                    <form action={onRemove}>
                      <input type="hidden" name={CHANNEL_FIELD.topicSlug} value={topicSlug} />
                      <input type="hidden" name={CHANNEL_FIELD.platform} value={p} />
                      <input type="hidden" name={CHANNEL_FIELD.channel} value={c.channel} />
                      <button type="submit" className="btn btn-quiet btn-small" disabled={pending}>
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}

      <form className="channels-add form-grid" action={onAdd}>
        <input type="hidden" name={CHANNEL_FIELD.topicSlug} value={topicSlug} />
        <label className="field">
          <span>Platform</span>
          <select
            name={CHANNEL_FIELD.platform}
            value={platform}
            onChange={(e) => setPlatform(e.target.value as ChannelPlatform)}
          >
            {CHANNEL_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {platformLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Channel</span>
          <input name={CHANNEL_FIELD.channel} placeholder={CHANNEL_HINT[platform]} />
        </label>
        <button type="submit" className="btn btn-small" disabled={pending}>
          Add channel
        </button>
        <span className="hint">{CHANNEL_HINT[platform]}</span>
      </form>
    </div>
  );
}
