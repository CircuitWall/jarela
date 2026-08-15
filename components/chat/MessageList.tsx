"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, X, ArrowDown, Eye, EyeOff } from "lucide-react";
import type { AgentConfig, ContentPart, Message, UserProfile } from "@/api/types";
import { ToolList, type ToolEvent } from "./ToolList";
import { MessageBubble } from "./MessageBubble";
import { ContextBoundaryDivider, WarmSummaryCard } from "./ContextBoundary";
import { useMessageFilters, MESSAGE_FILTER_KEYS, type MessageFilterKey } from "@/hooks/useMessageFilters";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { MetaRow } from "@/components/ui/MetaRow";
import { Dialog } from "@/components/ui/Dialog";

interface SystemNotice {
  id: string;
  text: string;
}

interface QueuedMessageView {
  id: string;
  text: string;
  attachmentCount: number;
}

interface Props {
  threadId?: string | null;
  messages: Message[];
  notices?: SystemNotice[];
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  streamingContent?: string;
  thinkingContent?: string;
  toolEvents?: ToolEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  queuedMessages?: QueuedMessageView[];
  onRemoveQueued?: (id: string) => void;
  // ADR-0042 — explicit context boundary state. The boundary divider is
  // rendered in the message stream right after the last message older than
  // `hotSince` (or above the first loaded message when the pin sits earlier
  // than the visible window). The warm-summary card sits directly above
  // the divider and shows the latest persisted recap.
  hotSince?: string | null;
  warmSummary?: string | null;
  warmSummaryBefore?: string | null;
  warmSummaryComputedAt?: string | null;
  warmSummarySourceMessages?: number | null;
  warmSummarySourceChars?: number | null;
  onSetContextPin?: (hot_since: string | null) => void;
  streaming?: boolean;
  // Thread-level context window cap, forwarded to each MessageBubble so
  // the ContextUsageBar has a baseline for rows whose own usage snapshot
  // predates the per-row column.
  contextWindowTokens?: number | null;
  // Resend a previously-sent user prompt as a new turn. Forwarded to each
  // user-role MessageBubble; absent => retry button is hidden.
  onRetryMessage?: (text: string, attachments: ContentPart[]) => void;
}

export function MessageList({ threadId, messages, notices, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, onLoadMore, queuedMessages, onRemoveQueued, hotSince, warmSummary, warmSummaryBefore, warmSummaryComputedAt, warmSummarySourceMessages, warmSummarySourceChars, onSetContextPin, streaming, contextWindowTokens, onRetryMessage }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const maskRegionRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollLockRef = useRef<-1 | 0 | 1>(0);
  const autoScrollVelocityRef = useRef(0);
  const autoScrollPointerYRef = useRef<number | null>(null);
  const dragYRef = useRef<number | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const suppressBoundaryClickRef = useRef(false);
  const dragGuideTopRef = useRef<number | null>(null);
  const dragGuideRef = useRef<HTMLDivElement>(null);
  const dragGuideStatsRef = useRef<HTMLSpanElement>(null);
  const dragMaskRef = useRef<HTMLDivElement>(null);
  const previewHotSinceRef = useRef<string | null>(null);
  const { filters, toggle, reset } = useMessageFilters(agentConfig?.id ?? null);
  const autoRecoveredRef = useRef<string | null>(null);
  const [isDraggingFocus, setIsDraggingFocus] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingHotSince, setPendingHotSince] = useState<string | null>(null);
  const [topControlsOpen, setTopControlsOpen] = useState(false);
  const [summaryPopoverOpen, setSummaryPopoverOpen] = useState(false);
  const [summaryPopoverTop, setSummaryPopoverTop] = useState<number | null>(null);

  // Apply category filter. Messages with no `category` (NULL = ordinary
  // chat) are always shown; tagged messages are gated by their toggle.
  // The `tool_use` and `thinking` filters do NOT remove whole messages —
  // they're handled below by gating the inline ToolList / ThinkingLine.
  const visibleMessages = useMemo(() => {
    return messages.filter((m) => {
      const cat = m.category;
      if (!cat) return true;
      if (cat === "scheduled_task") return filters.scheduled_task;
      if (cat === "watcher") return filters.watcher;
      if (cat === "bridge") return filters.bridge;
      if (cat === "extension") return filters.extension;
      if (cat === "page_capture") return filters.page_capture;
      if (cat === "synthetic") return filters.synthetic;
      // Unknown future categories: show by default so forward-compat clients
      // never silently drop content the server thinks should be visible.
      return true;
    });
  }, [messages, filters.scheduled_task, filters.watcher, filters.bridge, filters.extension, filters.page_capture, filters.synthetic]);

  const hiddenCount = messages.length - visibleMessages.length;
  const effectiveHotSince = hotSince ?? null;

  function pickHotSinceFromPointerY(clientY: number): string | null {
    const root = scrollRef.current;
    if (!root || visibleMessages.length === 0) return hotSince ?? null;
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-hot-candidate='1']"));
    if (candidates.length === 0) return hotSince ?? null;

    // Use on-screen message positions (midpoints between consecutive rows)
    // so small drags move the boundary locally instead of jumping by a large
    // ratio across the entire loaded transcript.
    for (let i = 0; i < candidates.length - 1; i++) {
      const currentTop = candidates[i].getBoundingClientRect().top;
      const nextTop = candidates[i + 1].getBoundingClientRect().top;
      const midpoint = currentTop + (nextTop - currentTop) / 2;
      if (clientY < midpoint) return candidates[i].dataset.createdAt ?? null;
    }
    return candidates[candidates.length - 1]?.dataset.createdAt ?? null;
  }

  function boundaryIndexFor(hot: string | null): number {
    if (!hot || visibleMessages.length === 0) return -1;
    const i = visibleMessages.findIndex((m) => m.created_at >= hot);
    if (i !== -1) return i;
    return visibleMessages.length;
  }

  function countOlderForHotSince(hot: string | null): number {
    const interactiveBoundary = !!onSetContextPin && visibleMessages.length > 0;
    const i = hot ? visibleMessages.findIndex((m) => m.created_at >= hot) : -1;
    const pinAfterAll =
      (!!hot && visibleMessages.length > 0 && i === -1
        && visibleMessages[visibleMessages.length - 1].created_at < hot)
      || (!hot && interactiveBoundary);
    if (pinAfterAll) return visibleMessages.length;
    if (hot && i !== -1) return i;
    return 0;
  }

  function lineStatsForHotSince(hot: string | null): string {
    const older = countOlderForHotSince(hot);
    const recent = Math.max(0, visibleMessages.length - older);
    return `recent ${recent} · warm ${older}`;
  }

  function boundaryTopForHotSince(hot: string | null): number | null {
    const root = scrollRef.current;
    const host = hostRef.current;
    if (!root || !host || visibleMessages.length === 0) return null;
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-hot-candidate='1']"));
    if (candidates.length === 0) return null;
    const hostTop = host.getBoundingClientRect().top;

    if (!hot) {
      return candidates[candidates.length - 1].getBoundingClientRect().bottom - hostTop;
    }

    const i = visibleMessages.findIndex((m) => m.created_at >= hot);
    if (i === -1) {
      return candidates[candidates.length - 1].getBoundingClientRect().bottom - hostTop;
    }

    const target = candidates[i];
    if (!target) return null;
    return target.getBoundingClientRect().top - hostTop;
  }

  function committedBoundaryLineTop(): number | null {
    const root = scrollRef.current;
    const host = hostRef.current;
    if (!root || !host) return null;
    const boundary = root.querySelector<HTMLElement>("[data-focus-boundary='1'] [aria-label='conversation focus boundary']");
    if (!boundary) return boundaryTopForHotSince(hotSince ?? null);
    const hostTop = host.getBoundingClientRect().top;
    const rect = boundary.getBoundingClientRect();
    return rect.top + (rect.height / 2) - hostTop;
  }

  function firstMessageTopForMask(): number | null {
    const root = scrollRef.current;
    const region = maskRegionRef.current;
    if (!root || !region) return null;
    const first = root.querySelector<HTMLElement>("[data-hot-candidate='1']");
    if (!first) return null;
    return first.getBoundingClientRect().top - region.getBoundingClientRect().top;
  }

  function boundaryLineTopForMask(): number | null {
    const root = scrollRef.current;
    const region = maskRegionRef.current;
    if (!root || !region) return null;
    const boundary = root.querySelector<HTMLElement>("[data-focus-boundary='1'] [aria-label='conversation focus boundary']");
    if (boundary) {
      const rect = boundary.getBoundingClientRect();
      return rect.top + (rect.height / 2) - region.getBoundingClientRect().top;
    }

    const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-hot-candidate='1']"));
    if (candidates.length === 0 || visibleMessages.length === 0) return null;

    const regionTop = region.getBoundingClientRect().top;
    const effective = hotSince ?? null;
    if (!effective) {
      return candidates[candidates.length - 1].getBoundingClientRect().bottom - regionTop;
    }

    const i = visibleMessages.findIndex((m) => m.created_at >= effective);
    if (i === -1) {
      return candidates[candidates.length - 1].getBoundingClientRect().bottom - regionTop;
    }

    const target = candidates[i];
    if (!target) return null;
    return target.getBoundingClientRect().top - regionTop;
  }

  function updateBoundaryMask() {
    const mask = dragMaskRef.current;
    if (!mask) return;
    const topStart = firstMessageTopForMask();
    const boundaryTop = boundaryLineTopForMask();
    if (topStart === null || boundaryTop === null) {
      mask.style.opacity = "0";
      mask.style.height = "0px";
      return;
    }

    const top = Math.min(topStart, boundaryTop);
    const height = Math.max(0, Math.abs(boundaryTop - topStart));
    if (height < 2) {
      mask.style.opacity = "0";
      mask.style.height = "0px";
      return;
    }

    mask.style.transform = `translateY(${top}px)`;
    mask.style.height = `${height}px`;
    mask.style.opacity = "1";
  }

  function clearDragState() {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollLockRef.current = 0;
    autoScrollVelocityRef.current = 0;
    autoScrollPointerYRef.current = null;
    dragYRef.current = null;
    dragStartYRef.current = null;
    dragMovedRef.current = false;
    dragPointerIdRef.current = null;
    previewHotSinceRef.current = null;
    dragGuideTopRef.current = null;
    setIsDraggingFocus(false);
    if (dragGuideRef.current) dragGuideRef.current.style.opacity = "0";
    if (dragGuideStatsRef.current) dragGuideStatsRef.current.textContent = "";
    requestAnimationFrame(() => updateBoundaryMask());
  }

  function stepAutoScroll() {
    const scroller = scrollRef.current;
    if (!scroller) {
      autoScrollFrameRef.current = null;
      return;
    }
    const velocity = autoScrollVelocityRef.current;
    if (velocity === 0) {
      autoScrollFrameRef.current = null;
      return;
    }

    const prevTop = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextTop = Math.max(0, Math.min(maxTop, prevTop + velocity));
    scroller.scrollTop = nextTop;

    const pointerY = autoScrollPointerYRef.current;
    if (pointerY !== null) {
      const rect = scroller.getBoundingClientRect();
      const clampedY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, pointerY));
      scheduleDragFromPointer(clampedY);
    }

    if (Math.abs(nextTop - prevTop) < 0.1 && (nextTop === 0 || nextTop === maxTop)) {
      autoScrollFrameRef.current = null;
      return;
    }
    autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
  }

  function updateAutoScrollFromPointer(clientY: number) {
    autoScrollPointerYRef.current = clientY;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edge = Math.min(180, Math.max(72, rect.height * 0.24));
    const release = edge + 18;
    let lock = autoScrollLockRef.current;

    if (lock === -1 && clientY > rect.top + release) lock = 0;
    if (lock === 1 && clientY < rect.bottom - release) lock = 0;
    if (lock === 0) {
      if (clientY < rect.top + edge) lock = -1;
      else if (clientY > rect.bottom - edge) lock = 1;
    }

    autoScrollLockRef.current = lock;
    let velocity = 0;

    if (lock === -1) {
      const depth = Math.max(0, rect.top + edge - clientY);
      const t = Math.min(1, depth / edge);
      velocity = -(2 + (t * t * 26));
    } else if (lock === 1) {
      const depth = Math.max(0, clientY - (rect.bottom - edge));
      const t = Math.min(1, depth / edge);
      velocity = 2 + (t * t * 26);
    }

    autoScrollVelocityRef.current = velocity;
    if (velocity !== 0 && autoScrollFrameRef.current === null) {
      atBottomRef.current = false;
      autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
    }
  }

  function updateDragFromPointer(clientY: number) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const clampedY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY));

    const hostTop = hostRef.current?.getBoundingClientRect().top;
    if (hostTop !== undefined && dragGuideRef.current) {
      const guideTop = clampedY - hostTop;
      dragGuideTopRef.current = guideTop;
      dragGuideRef.current.style.transform = `translateY(${guideTop}px)`;
      dragGuideRef.current.style.opacity = "1";
    }

    const next = pickHotSinceFromPointerY(clampedY);
    if (previewHotSinceRef.current !== next) {
      previewHotSinceRef.current = next;
      if (dragGuideStatsRef.current) {
        dragGuideStatsRef.current.textContent = lineStatsForHotSince(next);
      }
    }
    updateBoundaryMask();
  }

  function scheduleDragFromPointer(clientY: number) {
    dragYRef.current = clientY;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      if (dragYRef.current === null) return;
      updateDragFromPointer(dragYRef.current);
    });
  }

  function commitDragCandidate(next: string | null) {
    clearDragState();
    if (!next || next === (hotSince ?? null)) return;
    setPendingHotSince(next);
    setConfirmOpen(true);
  }

  function handleBoundaryPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (streaming || !onSetContextPin) return;
    atBottomRef.current = false;
    dragPointerIdRef.current = e.pointerId;
    dragStartYRef.current = e.clientY;
    dragMovedRef.current = false;
    previewHotSinceRef.current = hotSince ?? null;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingFocus(true);
    updateAutoScrollFromPointer(e.clientY);
    scheduleDragFromPointer(e.clientY);
  }

  function handleBoundaryPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (dragStartYRef.current !== null && Math.abs(e.clientY - dragStartYRef.current) > 3) {
      dragMovedRef.current = true;
    }
    updateAutoScrollFromPointer(e.clientY);
    scheduleDragFromPointer(e.clientY);
  }

  function handleBoundaryPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!dragMovedRef.current) {
      suppressBoundaryClickRef.current = true;
      requestAnimationFrame(() => {
        suppressBoundaryClickRef.current = false;
      });
      toggleSummaryPopoverAt(e.clientY);
      clearDragState();
      return;
    }
    const y = dragYRef.current ?? e.clientY;
    const next = pickHotSinceFromPointerY(y);
    suppressBoundaryClickRef.current = true;
    requestAnimationFrame(() => {
      suppressBoundaryClickRef.current = false;
    });
    commitDragCandidate(next);
  }

  function handleBoundaryPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    clearDragState();
  }

  function toggleSummaryPopoverAt(clientY: number) {
    const host = hostRef.current;
    if (!host) {
      setSummaryPopoverOpen((x) => !x);
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const lineTop = committedBoundaryLineTop();
    const fallbackTop = Math.max(20, clientY - hostRect.top + 8);
    const top = Math.max(12, Math.min(hostRect.height - 260, (lineTop ?? fallbackTop) + 14));
    setSummaryPopoverTop(top);
    setSummaryPopoverOpen((x) => !x);
  }

  function handleBoundaryClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (suppressBoundaryClickRef.current) return;
    toggleSummaryPopoverAt(e.clientY);
  }

  const currentBoundaryIndex = boundaryIndexFor(hotSince ?? null);
  const pendingBoundaryIndex = boundaryIndexFor(pendingHotSince);
  const currentHotCount = currentBoundaryIndex < 0 ? null : visibleMessages.length - currentBoundaryIndex;
  const nextHotCount = pendingBoundaryIndex < 0 ? null : visibleMessages.length - pendingBoundaryIndex;
  const removesFromRecent =
    currentHotCount !== null && nextHotCount !== null
      ? nextHotCount < currentHotCount
      : false;
  const hasWarmSummary = !!warmSummary;
  const summaryFresh = hasWarmSummary && warmSummaryBefore === (hotSince ?? null);
  const summaryUpdating = hasWarmSummary && !summaryFresh && !!streaming;
  const summaryStale = hasWarmSummary && !summaryFresh && !summaryUpdating;

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
      if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
    };
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => updateBoundaryMask());
  }, [isDraggingFocus, hotSince, visibleMessages]);

  // Self-heal stale/accidental filter states that blank an entire thread.
  // If a thread has persisted messages but every one is filtered out, users
  // perceive this as "chat is empty". Auto-reset once per thread snapshot so
  // content remains visible without requiring manual recovery.
  useEffect(() => {
    if (messages.length === 0 || streamingContent) return;
    if (visibleMessages.length > 0) return;
    if (hiddenCount !== messages.length) return;
    const lastId = messages[messages.length - 1]?.id ?? "none";
    const key = `${threadId ?? "no-thread"}:${messages.length}:${lastId}`;
    if (autoRecoveredRef.current === key) return;
    autoRecoveredRef.current = key;
    reset();
  }, [threadId, messages, visibleMessages.length, hiddenCount, streamingContent, reset]);

  // Surface a category chip in the toolbar only if it can actually do
  // something useful right now: scheduled_task/bridge/synthetic chips
  // appear only when at least one such message exists in the loaded
  // transcript; tool_use appears when any assistant message has tool
  // events; thinking appears when there's live thinking content (the
  // only place it currently surfaces).
  const availableChips = useMemo(() => {
    const set = new Set<MessageFilterKey>();
    for (const m of messages) {
      if (m.category === "scheduled_task") set.add("scheduled_task");
      else if (m.category === "watcher") set.add("watcher");
      else if (m.category === "bridge") set.add("bridge");
      else if (m.category === "extension") set.add("extension");
      else if (m.category === "page_capture") set.add("page_capture");
      else if (m.category === "synthetic") set.add("synthetic");
      if (m.tool_events && m.tool_events.length > 0) set.add("tool_use");
    }
    if (thinkingContent) set.add("thinking");
    if (toolEvents && toolEvents.length > 0) set.add("tool_use");
    return MESSAGE_FILTER_KEYS.filter((k) => set.has(k));
  }, [messages, thinkingContent, toolEvents]);
  // Count of tool_call ids that haven't been matched by a tool_result yet.
  // Drives the streaming-bubble's CountdownRing pause so the wall-clock
  // indicator matches the run-registry's effective-elapsed semantics
  // (tool execution time is excluded from the agent's budget).
  const inflightToolCount = useMemo(() => {
    if (!toolEvents || toolEvents.length === 0) return 0;
    const open = new Set<string>();
    for (const ev of toolEvents) {
      if (ev.phase === "call") open.add(ev.id);
      else if (ev.phase === "result") open.delete(ev.id);
    }
    return open.size;
  }, [toolEvents]);

  // Tracks whether the user was at the bottom on the most recent scroll event.
  // After every render, if true, we snap to bottom — which means: while the
  // user is at the bottom they "follow" automatically; if they scroll away,
  // they stay where they are; when they scroll back to the bottom they resume
  // following. No timers, no growth checks, no programmatic-scroll guards —
  // the only signal is the user's own scroll position. CSS `overflow-anchor`
  // (browser-default) handles the pagination case (older content prepended
  // keeps visible content stable).
  const atBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Anchor for older-message pagination. When the user scrolls near the top
  // and we call onLoadMore, we snapshot the viewport (scrollHeight + scrollTop)
  // here. After the parent prepends the new messages and React commits, the
  // layout effect below compensates scrollTop by the height delta so the
  // content the user was looking at stays at the same on-screen position
  // instead of remaining pinned to scrollTop=0 (which makes the viewport
  // "jump" to the very oldest message).
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Don't snap to bottom while we're in the middle of restoring scroll
    // after a load-more prepend — the layout effect below owns scrollTop
    // until the anchor is consumed.
    if (prependAnchorRef.current) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }); // intentionally no deps — runs after every render

  // Keep the bottom pinned when the scroll container *itself* resizes —
  // not just when messages change. When the on-screen keyboard opens,
  // `100dvh` shrinks AppShell, which shrinks this container without
  // triggering a React render, so the post-render effect above never
  // fires. Without this observer the latest messages drop below the
  // visible area and the user has to scroll down to find them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (prependAnchorRef.current) return;
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      updateBoundaryMask();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Restore scroll position after older messages have been prepended.
  // useLayoutEffect runs synchronously after DOM mutations but before paint,
  // so the user never sees the intermediate "scrolled to oldest" frame.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!el || !anchor) return;
    if (loadingMore) return; // wait until the fetch settled
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      el.scrollTop = anchor.scrollTop + delta;
      atBottomRef.current = false;
    }
    prependAnchorRef.current = null;
  }, [messages, loadingMore]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) {
      // Snapshot BEFORE asking the parent to fetch so we can compensate the
      // scroll position once the new (older) messages arrive in props.
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      onLoadMore();
    }
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    atBottomRef.current = isAtBottom;
    setShowScrollButton(!isAtBottom && messages.length > 0);
    updateBoundaryMask();
  }

  // Resolve `#msg-<id>` deep links: scroll the matching bubble into view and
  // flash the same highlight ring used by settings deep links. Re-runs when
  // the message list grows (so a fresh-loaded page that contained the target
  // resolves once it's in the DOM) and on every `hashchange` so the same
  // in-thread link can be clicked twice.
  useEffect(() => {
    function scrollToHashTarget() {
      if (typeof window === "undefined") return;
      const hash = window.location.hash;
      if (!hash.startsWith("#msg-")) return;
      const id = decodeURIComponent(hash.slice(5));
      const root = scrollRef.current;
      if (!root) return;
      requestAnimationFrame(() => {
        const safe = id.replace(/"/g, '\\"');
        const el = root.querySelector(`[data-message-id="${safe}"]`) as HTMLElement | null;
        if (!el) return;
        atBottomRef.current = false;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("jarela-deep-link-flash");
        setTimeout(() => el.classList.remove("jarela-deep-link-flash"), 1600);
        // Strip the hash so the next streaming message / list-length change
        // doesn't yank the view back to this anchor. replaceState avoids
        // triggering a hashchange event (which would re-enter this handler).
        const { pathname, search } = window.location;
        window.history.replaceState(null, "", pathname + search);
      });
    }
    scrollToHashTarget();
    window.addEventListener("hashchange", scrollToHashTarget);
    return () => window.removeEventListener("hashchange", scrollToHashTarget);
  }, [messages.length]);

  // Handle orientation changes and resizes to maintain scroll position
  useEffect(() => {
    function handleResize() {
      const el = scrollRef.current;
      if (!el || !atBottomRef.current) return;
      // Re-snap to bottom on resize/orientation change if user was already at bottom
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollButton(false);
  }

  function scrollToBoundaryLine() {
    const root = scrollRef.current;
    if (!root) return;
    const boundary = root.querySelector("[data-focus-boundary='1']") as HTMLElement | null;
    if (!boundary) return;
    atBottomRef.current = false;
    boundary.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div ref={hostRef} className="flex-1 flex flex-col min-h-0 relative">
      {visibleMessages.length > 0 && (
        <div className="shrink-0 px-4 pt-[calc(var(--app-safe-top)+3rem)] pb-1">
          <div className="w-full border-b border-border/45 bg-surface/30 px-2 py-1 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setTopControlsOpen((v) => !v)}
              aria-expanded={topControlsOpen}
              className="w-full flex items-center gap-2 py-0.5 text-[11px] text-fg-faint hover:text-fg transition-colors"
            >
              <CollapseChevron open={topControlsOpen} size={10} />
              <span className="font-semibold uppercase tracking-[0.16em]">Filters & focus</span>
              {hiddenCount > 0 && (
                <span className="ml-auto text-[10px] text-fg-faint" aria-live="polite">
                  {hiddenCount} hidden
                </span>
              )}
            </button>

            {topControlsOpen && (
              <div className="mt-1 flex items-center gap-1.5 flex-wrap py-1">
                {availableChips.map((key) => {
                  const on = filters[key];
                  const Icon = on ? Eye : EyeOff;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggle(key)}
                      className={[
                        "inline-flex items-center gap-1 rounded-none border px-2 py-0.5 text-[10px] leading-4 transition-colors",
                        on
                          ? "border-border/70 bg-surface-2/70 text-fg-muted hover:text-fg"
                          : "border-border/35 bg-transparent text-fg-faint line-through decoration-fg-faint/60 hover:text-fg-muted",
                      ].join(" ")}
                      title={on ? `Hide ${CHIP_LABELS[key]} messages` : `Show ${CHIP_LABELS[key]} messages`}
                      aria-pressed={on}
                    >
                      <Icon size={10} />
                      <span>{CHIP_LABELS[key]}</span>
                    </button>
                  );
                })}
                {onSetContextPin && (
                  <button
                    type="button"
                    onClick={scrollToBoundaryLine}
                    className="control-tap ml-auto rounded-none border border-border/60 bg-surface-2/70 px-2 py-0.5 text-[10px] leading-4 text-fg-faint transition-colors hover:border-accent/40 hover:text-fg"
                    title="Locate the focus boundary in the message list"
                  >
                    Locate boundary line
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div ref={maskRegionRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 h-full overflow-y-auto overflow-x-hidden px-4 py-4 panel-scrollbar"
          style={{
            // Scroll-anchor jumps (deep-link to a message) land below the
            // floating header, not under it.
            scrollPaddingTop: "calc(3rem + var(--app-safe-top))",
          }}
        >
        {hasMore && (
          <div className="text-center py-1.5 text-[11px] text-fg-faint select-none">
            {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
          </div>
        )}
        {visibleMessages.length === 0 && !streamingContent && (
          <div className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
            {messages.length === 0 ? (
              <span>Send a message to begin</span>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center px-4">
                <span>{hiddenCount} message{hiddenCount === 1 ? " is" : "s are"} hidden by filters</span>
                <button
                  type="button"
                  onClick={reset}
                  className="control-tap text-xs px-2.5 py-1 rounded-md border border-border bg-surface-2 text-fg-muted hover:text-fg hover:bg-surface-3 transition-colors"
                >
                  Show all messages
                </button>
              </div>
            )}
          </div>
        )}
      {(() => {
        // ADR-0042. The boundary divider + warm summary card live INSIDE the
        // message stream so they scroll with content (not above as a fixed
        // banner). `boundaryIndex` is the index of the first hot message in
        // the visible list; everything before it is older-than-pin and gets
        // covered by the warm summary card sitting above the divider.
        //
        // If `hotSince` sits strictly after every loaded message (the
        // post-/compact "/new" state), every visible message is warm and
        // the boundary is rendered AFTER the last bubble.
        const boundaryIndex = effectiveHotSince
          ? visibleMessages.findIndex((m) => m.created_at >= effectiveHotSince)
          : -1;
        const interactiveBoundary = !!effectiveHotSince && !!onSetContextPin && visibleMessages.length > 0;
        const pinAfterAll =
          (!!effectiveHotSince && visibleMessages.length > 0 && boundaryIndex === -1
            && visibleMessages[visibleMessages.length - 1].created_at < effectiveHotSince)
          || (!effectiveHotSince && interactiveBoundary);
        const hasBoundary = (effectiveHotSince ? (boundaryIndex !== -1 || pinAfterAll) : interactiveBoundary);
        const olderInVisible = pinAfterAll
          ? visibleMessages.length
          : hasBoundary ? boundaryIndex : 0;
        // "+ N more we don't know about yet" — older pages are likely unloaded.
        const olderCountLabel = olderInVisible + (hasMore ? 1 : 0);

        const renderBoundary = (key: string) => (
          <div key={key} data-focus-boundary="1">
            <ContextBoundaryDivider
              sourceMessages={warmSummarySourceMessages ?? null}
              sourceChars={warmSummarySourceChars ?? null}
              summaryChars={warmSummary ? warmSummary.length : null}
              lineStats={lineStatsForHotSince(effectiveHotSince)}
              draggable={!!onSetContextPin}
              hidden={isDraggingFocus}
              disabled={!!streaming}
              onClick={handleBoundaryClick}
              onPointerDown={handleBoundaryPointerDown}
              onPointerMove={handleBoundaryPointerMove}
              onPointerUp={handleBoundaryPointerUp}
              onPointerCancel={handleBoundaryPointerCancel}
            />
          </div>
        );

        const nodes = visibleMessages.flatMap((msg, i) => {
          const startsTurn = i === 0 || visibleMessages[i - 1].role !== msg.role;
          const out = [] as React.ReactNode[];
          if (hasBoundary && !pinAfterAll && i === boundaryIndex) {
            out.push(renderBoundary(`boundary-${msg.id}`));
          }
          out.push(
            <div
              key={msg.id}
              id={`msg-${msg.id}`}
              data-message-id={msg.id}
              data-hot-candidate="1"
              data-created-at={msg.created_at}
              className={startsTurn && i > 0 ? "mt-3" : undefined}
            >
              <MessageBubble
                message={msg}
                threadId={threadId ?? null}
                agentConfig={agentConfig}
                userProfile={userProfile}
                showAvatar={startsTurn}
                showToolEvents={filters.tool_use}
                contextWindowTokens={contextWindowTokens ?? null}
                isLatest={i === visibleMessages.length - 1 && !streamingContent}
                onRetry={onRetryMessage}
              />
            </div>,
          );
          return out;
        });
        if (pinAfterAll) nodes.push(renderBoundary("boundary-tail"));
        return nodes;
      })()}
      {thinkingContent && filters.thinking && <ThinkingLine text={thinkingContent} />}
      {streamingContent && (
        <StreamingBubble
          content={streamingContent}
          threadId={threadId ?? null}
          agentConfig={agentConfig ?? null}
          showAvatar={messages.length === 0 || messages[messages.length - 1].role !== "assistant"}
          inflightToolCount={inflightToolCount}
        />
      )}
      {toolEvents && toolEvents.length > 0 && filters.tool_use && <ToolList events={toolEvents} />}
      {queuedMessages && queuedMessages.length > 0 && (
        <div className="flex flex-col gap-1 mt-2 mb-1">
          {queuedMessages.map((q) => (
            <QueuedBubble key={q.id} item={q} onRemove={onRemoveQueued} />
          ))}
        </div>
      )}
      {notices?.map((n) => (
        <div key={n.id} className="flex justify-center my-3">
          <span className="text-xs italic text-fg-faint bg-surface-2 px-3 py-1 rounded-full border border-border">
            {n.text}
          </span>
        </div>
      ))}
        </div>

        <div
          ref={dragMaskRef}
          className="pointer-events-none absolute left-0 right-0 top-0 z-40 opacity-0 transition-opacity duration-75"
          style={{
            transform: "translateY(0px)",
            height: "0px",
            background: "linear-gradient(to top, rgba(82,82,91,0.16) 0%, rgba(82,82,91,0.1) 38%, rgba(82,82,91,0.06) 100%)",
            borderBottom: "1px solid rgba(59,130,246,0.42)",
            backdropFilter: "grayscale(0.5) saturate(0.18) contrast(0.98)",
            WebkitBackdropFilter: "grayscale(0.5) saturate(0.18) contrast(0.98)",
          }}
        />
      </div>
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          style={{ bottom: "calc(1rem + var(--app-safe-bottom))" }}
          className="absolute right-4 p-2 rounded-full bg-accent/40 hover:bg-accent/80 text-white backdrop-blur-sm shadow-md transition-all animate-in fade-in slide-in-from-bottom-2 duration-200 z-20"
          title="Scroll to latest message"
          aria-label="Scroll to latest message"
        >
          <ArrowDown size={18} />
        </button>
      )}

      {isDraggingFocus && (
        <>
          <div ref={dragGuideRef} className="pointer-events-none absolute left-4 right-4 z-50 opacity-0" style={{ transform: "translateY(0px)" }}>
          <div className="h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent opacity-95 shadow-[0_0_8px_rgba(59,130,246,0.55)]" />
          <span
            ref={dragGuideStatsRef}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-faint bg-surface/75 px-1.5 rounded border border-border/60"
          >
            {lineStatsForHotSince(hotSince ?? null)}
          </span>
          </div>
        </>
      )}

      {summaryPopoverOpen && (
        <div
          data-testid="summary-popover"
          className="absolute left-1/2 -translate-x-1/2 z-40 w-[min(42rem,calc(100%-2rem))]"
          style={{ top: `${summaryPopoverTop ?? 20}px` }}
        >
          <div className="rounded-xl border border-border bg-surface/95 backdrop-blur-md shadow-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-fg">Earlier messages summary</span>
                <span
                  className={[
                    "text-[10px] px-1.5 py-px rounded border inline-flex items-center gap-1",
                    summaryUpdating ? "border-accent/40 bg-accent/10 text-accent" :
                    summaryFresh ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
                    summaryStale ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" :
                    "border-border bg-surface-2 text-fg-faint",
                  ].join(" ")}
                >
                  {summaryUpdating && (
                    <span
                      className="h-2 w-2 rounded-full bg-accent animate-pulse"
                      aria-label="Summary updating"
                    />
                  )}
                  <span>
                    {summaryUpdating
                      ? "updating"
                      : summaryFresh
                      ? "ready"
                      : summaryStale
                      ? "needs refresh"
                      : "pending"}
                  </span>
                </span>
              </div>
              <button
                type="button"
                data-testid="summary-popover-close"
                onClick={() => setSummaryPopoverOpen(false)}
                className="text-xs px-2 py-1 rounded border border-border bg-surface-2 text-fg-muted hover:text-fg"
              >
                Close
              </button>
            </div>
            {!summaryUpdating && (
              <p className="text-[11px] text-fg-faint mb-2">
                {summaryFresh
                  ? "Showing the latest summary for messages above the boundary line."
                  : summaryStale
                  ? "This summary is from an older focus and will refresh after the next reply."
                  : "No summary yet. It will appear after the next reply."}
              </p>
            )}
            <WarmSummaryCard
              olderCount={countOlderForHotSince(hotSince ?? null) + (hasMore ? 1 : 0)}
              summary={warmSummary ?? null}
              summaryBefore={warmSummaryBefore ?? null}
              hotSince={hotSince ?? null}
              computedAt={warmSummaryComputedAt ?? null}
              streaming={!!streaming}
            />
          </div>
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false); setPendingHotSince(null); }}
        size="sm"
        align="center"
        dismissOnBackdrop={false}
      >
        <h4 className="text-sm font-semibold text-fg">Move conversation focus here?</h4>
        <p className="text-xs text-fg-muted leading-relaxed">
          Start a new conversation context from this point. New replies will prioritize recent messages below this line.
        </p>
        {nextHotCount !== null && (
          <p className="text-[11px] text-fg-faint">
            Recent in focus: {nextHotCount} loaded message{nextHotCount === 1 ? "" : "s"}; earlier loaded summary: {Math.max(0, visibleMessages.length - nextHotCount)}.
          </p>
        )}
        {removesFromRecent && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            This reduces recent in-focus messages. You can drag upward later to add history back.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => { setConfirmOpen(false); setPendingHotSince(null); }}
            className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (pendingHotSince && onSetContextPin) onSetContextPin(pendingHotSince);
              setConfirmOpen(false);
              setPendingHotSince(null);
            }}
            className="px-3 py-1.5 rounded-md text-xs border border-accent/40 bg-accent text-white hover:opacity-95 transition-opacity"
          >
            Move focus
          </button>
        </div>
      </Dialog>
    </div>
  );
}

const CHIP_LABELS: Record<MessageFilterKey, string> = {
  scheduled_task: "scheduled",
  watcher: "watcher",
  bridge: "bridge",
  extension: "extension",
  page_capture: "captures",
  synthetic: "system",
  tool_use: "tools",
  thinking: "thinking",
};

// Streaming-bubble wrapper. Wraps the in-flight assistant bubble so the
// `message` object passed to MessageBubble keeps a stable identity across
// renders that don't actually change the streaming text — without this
// the inline `{ role, content, streaming: true }` literal in the parent
// JSX would defeat MessageBubble's React.memo on every parent re-render.
const StreamingBubble = memo(function StreamingBubble({
  content,
  threadId,
  agentConfig,
  showAvatar,
  inflightToolCount,
}: {
  content: string;
  threadId: string | null;
  agentConfig: AgentConfig | null;
  showAvatar: boolean;
  inflightToolCount: number;
}) {
  const message = useMemo(
    () => ({ role: "assistant" as const, content, streaming: true }),
    [content],
  );
  return (
    <MessageBubble
      message={message}
      threadId={threadId}
      agentConfig={agentConfig}
      showAvatar={showAvatar}
      inflightToolCount={inflightToolCount}
    />
  );
});

function ThinkingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  const tail = preview.length > 60 ? preview.slice(-60) : preview;
  return (
    <div className="my-1 flex flex-col items-start gap-0.5">
      <MetaRow accent="amber" onClick={() => setOpen((v) => !v)} expanded={open}>
        <CollapseChevron open={open} size={9} />
        <span className="font-medium">thinking</span>
        {!open && <span className="truncate italic opacity-60 max-w-[18rem] text-left">{tail}</span>}
      </MetaRow>
      {open && (
        <pre className="w-full px-2 py-1.5 text-[10px] text-fg-muted whitespace-pre-wrap break-words font-mono bg-surface-2/40 rounded border border-border/40">
          {text}
        </pre>
      )}
    </div>
  );
}

// Ghosted user-bubble shown for messages the user typed while a previous run
// was still streaming. The chat input doesn't block; submissions stack up here
// and drain automatically as the agent finishes each turn. Click X to remove
// before it fires.
function QueuedBubble({
  item, onRemove,
}: {
  item: { id: string; text: string; attachmentCount: number };
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="flex flex-row-reverse gap-2 items-end opacity-60 group">
      <div className="shrink-0 w-7" />
      <div className="max-w-[75%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed bg-accent/40 border border-accent/40 border-dashed text-fg relative">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent/80 mb-1">
          <Clock size={10} />
          <span>queued</span>
          {item.attachmentCount > 0 && (
            <span className="text-fg-muted/70 normal-case tracking-normal">
              · {item.attachmentCount} attachment{item.attachmentCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        {onRemove && (
          <button
            onClick={() => onRemove(item.id)}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-surface-3 border border-border text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 hover:border-rose-700 hidden group-hover:flex items-center justify-center"
            title="Remove from queue"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
