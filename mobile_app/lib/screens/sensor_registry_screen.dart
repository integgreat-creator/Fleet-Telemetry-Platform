import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/repositories/sensor_repository.dart';

class SensorRegistryScreen extends StatefulWidget {
  final Vehicle vehicle;

  const SensorRegistryScreen({Key? key, required this.vehicle})
      : super(key: key);

  @override
  State<SensorRegistryScreen> createState() => _SensorRegistryScreenState();
}

class _SensorRegistryScreenState extends State<SensorRegistryScreen> {
  final SensorRepository _repository = SupabaseSensorRepository();

  List<Map<String, dynamic>> _sensors = [];
  List<Map<String, dynamic>> _filtered = [];
  bool _isLoading = true;
  String _searchQuery = '';
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _isLoading = true);
    final sensors = await _repository.getSensorRegistry(widget.vehicle.id);
    if (!mounted) return;
    setState(() {
      _sensors = sensors;
      _isLoading = false;
      _applyFilter();
    });
  }

  void _applyFilter() {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) {
      _filtered = List.from(_sensors);
    } else {
      _filtered = _sensors.where((s) {
        final name = ((s['display_name'] as String?) ?? '').toLowerCase();
        final type = ((s['sensor_type'] as String?) ?? '').toLowerCase();
        return name.contains(q) || type.contains(q);
      }).toList();
    }
  }

  Future<void> _toggleActive(Map<String, dynamic> sensor) async {
    final id = sensor['id'] as String;
    final current = sensor['is_active'] as bool? ?? true;
    final updated = !current;

    // Optimistic update
    setState(() {
      final idx = _sensors.indexWhere((s) => s['id'] == id);
      if (idx != -1) _sensors[idx] = {..._sensors[idx], 'is_active': updated};
      _applyFilter();
    });

    try {
      await SupabaseConfig.client
          .from('sensor_registry')
          .update({'is_active': updated})
          .eq('id', id);
    } catch (e) {
      // Revert on failure
      if (!mounted) return;
      setState(() {
        final idx = _sensors.indexWhere((s) => s['id'] == id);
        if (idx != -1) {
          _sensors[idx] = {..._sensors[idx], 'is_active': current};
        }
        _applyFilter();
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to update sensor: $e'),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /// Returns the staleness colour based on how recently the sensor was seen.
  Color _stalenessColor(Map<String, dynamic> sensor) {
    final raw = sensor['last_seen_at'] as String?;
    if (raw == null) return Colors.grey.shade400;
    final lastSeen = DateTime.tryParse(raw);
    if (lastSeen == null) return Colors.grey.shade400;
    final age = DateTime.now().difference(lastSeen);
    if (age.inSeconds < 60) return Colors.green;
    if (age.inMinutes < 10) return Colors.amber.shade700;
    return Colors.grey.shade500;
  }

  /// Human-readable relative time (e.g. "23 s ago", "5 min ago", "2 h ago").
  String _relativeTime(String? raw) {
    if (raw == null) return 'never';
    final lastSeen = DateTime.tryParse(raw);
    if (lastSeen == null) return 'unknown';
    final age = DateTime.now().difference(lastSeen);
    if (age.inSeconds < 60) return '${age.inSeconds} s ago';
    if (age.inMinutes < 60) return '${age.inMinutes} min ago';
    if (age.inHours < 24) return '${age.inHours} h ago';
    return '${age.inDays} d ago';
  }

  String _pollingLabel(Map<String, dynamic> sensor) {
    final ms = sensor['polling_interval_ms'] as int? ?? 1000;
    if (ms < 1000) return '${ms} ms';
    final secs = ms / 1000;
    return secs == secs.truncate() ? '${secs.toInt()} s' : '${secs.toStringAsFixed(1)} s';
  }

  String _formatReadingCount(Map<String, dynamic> sensor) {
    final count = sensor['reading_count'];
    if (count == null) return '0';
    final n = count is int ? count : int.tryParse(count.toString()) ?? 0;
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return n.toString();
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sensor Registry'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(20),
          child: Padding(
            padding: const EdgeInsets.only(left: 16, bottom: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                widget.vehicle.name,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context)
                          .colorScheme
                          .onPrimary
                          .withOpacity(0.8),
                    ),
              ),
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          // ── Search bar ──────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search sensors…',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchQuery.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchController.clear();
                          setState(() {
                            _searchQuery = '';
                            _applyFilter();
                          });
                        },
                      )
                    : null,
              ),
              onChanged: (value) {
                setState(() {
                  _searchQuery = value;
                  _applyFilter();
                });
              },
            ),
          ),

          // ── Count badge ─────────────────────────────────────────────────
          if (!_isLoading)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  _searchQuery.isEmpty
                      ? '${_sensors.length} sensor${_sensors.length == 1 ? '' : 's'} detected'
                      : '${_filtered.length} of ${_sensors.length} sensors',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Colors.grey.shade600,
                      ),
                ),
              ),
            ),

          // ── Body ────────────────────────────────────────────────────────
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : _sensors.isEmpty
                    ? _buildEmptyState()
                    : _filtered.isEmpty
                        ? _buildNoResultsState()
                        : ListView.builder(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
                            itemCount: _filtered.length,
                            itemBuilder: (context, index) =>
                                _buildSensorCard(_filtered[index]),
                          ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _isLoading ? null : _load,
        icon: _isLoading
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : const Icon(Icons.refresh),
        label: const Text('Refresh'),
      ),
    );
  }

  // ── Sensor card ───────────────────────────────────────────────────────────

  Widget _buildSensorCard(Map<String, dynamic> sensor) {
    final displayName = (sensor['display_name'] as String?)
            ?.isNotEmpty == true
        ? sensor['display_name'] as String
        : (sensor['sensor_type'] as String? ?? 'Unknown');
    final unit = sensor['unit'] as String? ?? '';
    final isActive = sensor['is_active'] as bool? ?? true;
    final staleness = _stalenessColor(sensor);
    final lastSeenText = _relativeTime(sensor['last_seen_at'] as String?);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header row ─────────────────────────────────────────────
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Staleness indicator dot
                Padding(
                  padding: const EdgeInsets.only(top: 3, right: 10),
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: staleness,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),

                // Sensor name + unit
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        displayName,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 15,
                        ),
                      ),
                      if (unit.isNotEmpty)
                        Text(
                          unit,
                          style: TextStyle(
                            fontSize: 12,
                            color: Colors.grey.shade600,
                          ),
                        ),
                    ],
                  ),
                ),

                // Active toggle
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      isActive ? 'Active' : 'Inactive',
                      style: TextStyle(
                        fontSize: 12,
                        color: isActive
                            ? Colors.green.shade700
                            : Colors.grey.shade500,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Switch(
                      value: isActive,
                      onChanged: (_) => _toggleActive(sensor),
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                  ],
                ),
              ],
            ),

            const SizedBox(height: 8),

            // ── Stats row ──────────────────────────────────────────────
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                // Reading count
                _InfoChip(
                  icon: Icons.bar_chart,
                  label: '${_formatReadingCount(sensor)} readings',
                  color: Colors.blue.shade700,
                ),

                // Last seen
                _InfoChip(
                  icon: Icons.access_time,
                  label: lastSeenText,
                  color: staleness,
                ),

                // Polling interval
                _InfoChip(
                  icon: Icons.timer_outlined,
                  label: _pollingLabel(sensor),
                  color: Colors.purple.shade600,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ── Empty states ──────────────────────────────────────────────────────────

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.sensors_off_outlined,
            size: 72,
            color: Colors.grey.shade400,
          ),
          const SizedBox(height: 16),
          Text(
            'No sensors detected yet',
            style: TextStyle(
              fontSize: 16,
              color: Colors.grey.shade600,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Sensors appear here once the vehicle\nstarts sending data.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 13,
              color: Colors.grey.shade500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNoResultsState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.search_off,
            size: 64,
            color: Colors.grey.shade400,
          ),
          const SizedBox(height: 16),
          Text(
            'No sensors match "$_searchQuery"',
            style: TextStyle(
              fontSize: 15,
              color: Colors.grey.shade600,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Small chip widget ─────────────────────────────────────────────────────────

class _InfoChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _InfoChip({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              color: color,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
