import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Offline retry queue for Supabase RPC calls that fail due to connectivity loss.
///
/// Events are serialized to JSON and stored in SharedPreferences so they
/// survive app restarts. On reconnection (wired via HeartbeatService) the
/// queue is flushed in FIFO order.
///
/// Design decisions:
///   • Max 100 entries — oldest dropped when full to bound storage.
///   • Entries older than 1 hour are discarded on flush — stale device events
///     and tamper alerts are misleading when delivered hours late.
///   • Location fixes are NOT queued — missed fixes create trip gaps, which
///     are already detected and surfaced by the gap-detection system.
///   • Heartbeats are NOT queued — they are high-frequency and meaningless
///     when delivered out of order.
class OfflineQueueService {
  static final OfflineQueueService _instance = OfflineQueueService._internal();
  factory OfflineQueueService() => _instance;
  OfflineQueueService._internal();

  static const _prefsKey  = 'offline_event_queue';
  static const _maxSize   = 100;
  static const _maxAge    = Duration(hours: 1);

  // In-memory list — source of truth; SharedPreferences is the persistence layer.
  final List<_QueueEntry> _queue = [];
  bool _flushing = false;
  bool _loaded   = false;

  int get pendingCount => _queue.length;

  // ── Enqueue ───────────────────────────────────────────────────────────────

  /// Add a failed RPC call to the retry queue.
  Future<void> enqueue({
    required String              rpc,
    required Map<String, dynamic> params,
  }) async {
    await _ensureLoaded();

    // Deduplicate: if an identical rpc+vehicle_id combo is already queued,
    // replace it with the latest params rather than stacking duplicates.
    final vehicleId = params['vehicle_id'] as String?;
    if (vehicleId != null) {
      _queue.removeWhere((e) => e.rpc == rpc &&
          (e.params['vehicle_id'] as String?) == vehicleId);
    }

    _queue.add(_QueueEntry(
      rpc:        rpc,
      params:     params,
      queuedAt:   DateTime.now().toUtc(),
    ));

    // Drop oldest when over capacity.
    if (_queue.length > _maxSize) {
      _queue.removeRange(0, _queue.length - _maxSize);
    }

    await _persist();
    debugPrint('OfflineQueueService: queued $rpc (${_queue.length} pending)');
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  /// Flush all queued entries by calling [send] for each one.
  ///
  /// [send] receives the RPC name and its params; it must return `true` on
  /// success and `false` if the call should be retried later.
  ///
  /// Entries older than [_maxAge] are silently discarded before sending.
  Future<void> flush(
    Future<bool> Function(String rpc, Map<String, dynamic> params) send,
  ) async {
    if (_flushing) return;
    _flushing = true;

    try {
      await _ensureLoaded();
      if (_queue.isEmpty) return;

      final now    = DateTime.now().toUtc();
      final fresh  = _queue.where((e) => now.difference(e.queuedAt) <= _maxAge).toList();
      final stale  = _queue.length - fresh.length;
      if (stale > 0) debugPrint('OfflineQueueService: discarding $stale stale entries');

      final failed = <_QueueEntry>[];
      for (final entry in fresh) {
        final ok = await send(entry.rpc, entry.params);
        if (!ok) failed.add(entry);
      }

      _queue
        ..clear()
        ..addAll(failed);
      await _persist();

      final sent = fresh.length - failed.length;
      debugPrint('OfflineQueueService: flushed $sent / ${fresh.length} entries '
          '(${failed.length} still pending)');
    } finally {
      _flushing = false;
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw   = prefs.getString(_prefsKey);
      if (raw == null) return;
      final list  = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      _queue.addAll(list.map(_QueueEntry.fromJson));
    } catch (e) {
      debugPrint('OfflineQueueService: failed to load persisted queue — $e');
    }
  }

  Future<void> _persist() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _prefsKey,
        jsonEncode(_queue.map((e) => e.toJson()).toList()),
      );
    } catch (e) {
      debugPrint('OfflineQueueService: persist error — $e');
    }
  }
}

// ── Internal model ─────────────────────────────────────────────────────────────

class _QueueEntry {
  final String               rpc;
  final Map<String, dynamic> params;
  final DateTime             queuedAt;

  const _QueueEntry({
    required this.rpc,
    required this.params,
    required this.queuedAt,
  });

  Map<String, dynamic> toJson() => {
    'rpc':      rpc,
    'params':   params,
    'queuedAt': queuedAt.toIso8601String(),
  };

  factory _QueueEntry.fromJson(Map<String, dynamic> j) => _QueueEntry(
    rpc:      j['rpc']      as String,
    params:   Map<String, dynamic>.from(j['params'] as Map),
    queuedAt: DateTime.parse(j['queuedAt'] as String),
  );
}
