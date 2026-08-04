/**
 * Rule-change watcher.
 *
 * Polls the official pages listed in the jurisdiction pack, stores a hash of
 * the meaningful text, and reports when it changes. Deliberately dumb: it does
 * not try to understand the change, it only tells you where to look. The agent
 * reading this output is the part that understands.
 *
 * This runs on your machine against public pages. It is a scheduled read of a
 * public website — the same thing you would do by hand, minus the forgetting.
 */

import { createHash } from 'node:crypto';

import type { DetectedChange, SourceSnapshot, WatchSource } from '../types.js';
import { changes, newId, snapshots } from '../store.js';

/**
 * Reduce an HTML page to comparable text.
 *
 * Scripts, styles and tags go; whitespace collapses. Without this, a rotating
 * CSRF token or an ad slot would report a "change" on every single poll and
 * you would learn to ignore the alerts — which is worse than no alerts.
 */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface CheckResult {
  source_id: string;
  label: string;
  url: string;
  status: 'unchanged' | 'changed' | 'first_seen' | 'error';
  detail?: string;
  change_id?: string;
  excerpt?: string;
}

export async function checkSource(source: WatchSource, timeoutMs = 20_000): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        // Identify the tool honestly rather than impersonating a browser.
        'user-agent': 'logistis-rule-watcher/0.1 (+https://github.com/e-sporos/logistis)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return { source_id: source.id, label: source.label, url: source.url, status: 'error', detail: `HTTP ${response.status}` };
    }

    const text = extractText(await response.text());
    const hash = hashText(text);
    const excerpt = text.slice(0, 600);
    const previous = snapshots.get(source.id);

    const snapshot: SourceSnapshot = {
      source_id: source.id,
      url: source.url,
      hash,
      checked_at: new Date().toISOString(),
      excerpt,
    };

    if (!previous) {
      snapshots.put(snapshot);
      return {
        source_id: source.id,
        label: source.label,
        url: source.url,
        status: 'first_seen',
        detail: 'Baseline recorded. Future checks will report changes against it.',
        excerpt,
      };
    }

    if (previous.hash === hash) {
      snapshots.put(snapshot);
      return { source_id: source.id, label: source.label, url: source.url, status: 'unchanged' };
    }

    const change: DetectedChange = {
      id: newId('chg'),
      source_id: source.id,
      url: source.url,
      detected_at: snapshot.checked_at,
      previous_hash: previous.hash,
      new_hash: hash,
      acknowledged: false,
    };
    changes.add(change);
    snapshots.put(snapshot);

    return {
      source_id: source.id,
      label: source.label,
      url: source.url,
      status: 'changed',
      change_id: change.id,
      detail: 'Content changed since the last check. Read the page and judge whether it affects you.',
      excerpt,
    };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : (error as Error).message;
    return { source_id: source.id, label: source.label, url: source.url, status: 'error', detail: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAll(sources: WatchSource[]): Promise<CheckResult[]> {
  // Sequential on purpose: a handful of government sites, no reason to hammer
  // them in parallel.
  const results: CheckResult[] = [];
  for (const source of sources) {
    results.push(await checkSource(source));
  }
  return results;
}
