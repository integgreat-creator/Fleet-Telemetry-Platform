import 'dart:math';
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';

/// Sensor value history for the last 7 days.
/// Shows a line chart per sensor type that has collected data.
class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  final _service = SupabaseService();

  List<_SensorHistory> _history = [];
  bool   _loading = false;
  String? _error;

  // ── Human-readable labels ─────────────────────────────────────────────────
  static const Map<String, String> _sensorLabels = {
    'rpm':                    'Engine RPM',
    'speed':                  'Vehicle Speed',
    'coolant_temp':           'Coolant Temp',
    'fuel_level':             'Fuel Level',
    'battery_voltage':        'Battery Voltage',
    'throttle_position':      'Throttle Position',
    'intake_air_temp':        'Intake Air Temp',
    'engine_load':            'Engine Load',
    'maf':                    'Mass Air Flow',
    'timing_advance':         'Timing Advance',
    'fuel_pressure':          'Fuel Pressure',
    'map':                    'Manifold Pressure',
    'short_fuel_trim_1':      'Short Fuel Trim',
    'long_fuel_trim_1':       'Long Fuel Trim',
    'o2_voltage_b1s1':        'O2 Sensor B1S1',
    'o2_voltage_b1s2':        'O2 Sensor B1S2',
    'catalyst_temp_b1s1':     'Catalyst Temp',
    'engine_runtime':         'Engine Runtime',
    'barometric_pressure':    'Barometric Pressure',
    'control_module_voltage': 'Control Module V',
    'absolute_load':          'Absolute Load',
    'engine_oil_temp':        'Engine Oil Temp',
  };

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    final vehicleId =
        context.read<VehicleProvider>().selectedVehicle?.id;
    if (vehicleId == null) return;

    setState(() { _loading = true; _error = null; });

    try {
      final rows = await _service.getSensorHistory(
        vehicleId: vehicleId,
        days:      7,
        limit:     4000,
      );

      // Group rows by sensor_type
      final grouped = <String, List<Map<String, dynamic>>>{};
      for (final row in rows) {
        final type = row['sensor_type'] as String? ?? 'unknown';
        grouped.putIfAbsent(type, () => []).add(row);
      }

      // Build _SensorHistory per type, oldest-first
      final startTime = DateTime.now().subtract(const Duration(days: 7));

      final historyList = grouped.entries.map((e) {
        final type   = e.key;
        final points = e.value;

        // Down-sample to at most 200 points per sensor for chart performance
        final sampled = _downsample(points, 200);

        final spots = <FlSpot>[];
        final values = <double>[];

        for (final p in sampled) {
          final raw = p['timestamp'] as String?;
          if (raw == null) continue;
          final ts  = DateTime.tryParse(raw);
          if (ts == null) continue;
          final val = (p['value'] as num?)?.toDouble();
          if (val == null) continue;

          final xMinutes = ts.difference(startTime).inMinutes.toDouble();
          spots.add(FlSpot(xMinutes, val));
          values.add(val);
        }

        if (spots.isEmpty) return null;

        final minVal = values.reduce(min);
        final maxVal = values.reduce(max);
        final avgVal = values.reduce((a, b) => a + b) / values.length;
        final unit   = (points.first['unit'] as String?) ?? '';

        return _SensorHistory(
          sensorType: type,
          label:      _sensorLabels[type] ?? type.replaceAll('_', ' '),
          unit:       unit,
          spots:      spots,
          minVal:     minVal,
          maxVal:     maxVal,
          avgVal:     avgVal,
          startTime:  startTime,
        );
      }).whereType<_SensorHistory>().toList();

      // Sort alphabetically by label
      historyList.sort((a, b) => a.label.compareTo(b.label));

      if (mounted) setState(() { _history = historyList; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Consumer<VehicleProvider>(
      builder: (context, vp, _) {
        if (vp.selectedVehicle == null) {
          return _EmptyState(
            icon:     Icons.bar_chart_rounded,
            title:    'No vehicle connected',
            subtitle: 'Connect an OBD adapter to start recording sensor history.',
          );
        }

        if (_loading) {
          return const Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                CircularProgressIndicator(color: AppColors.accentBlue),
                SizedBox(height: 16),
                Text('Loading sensor history…',
                    style: TextStyle(color: AppColors.textSecondary)),
              ],
            ),
          );
        }

        if (_error != null) {
          return _EmptyState(
            icon:        Icons.error_outline,
            title:       'Failed to load history',
            subtitle:    _error!,
            actionLabel: 'Retry',
            onAction:    _fetchHistory,
          );
        }

        if (_history.isEmpty) {
          return _EmptyState(
            icon:        Icons.show_chart_rounded,
            title:       'No history yet',
            subtitle:    'Sensor readings from the last 7 days will appear here once the OBD adapter starts sending data.',
            actionLabel: 'Refresh',
            onAction:    _fetchHistory,
          );
        }

        return RefreshIndicator(
          color:           AppColors.accentBlue,
          backgroundColor: AppColors.bgCard,
          onRefresh:       _fetchHistory,
          child: ListView(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            children: [
              // Header row
              Row(
                children: [
                  const Icon(Icons.history_rounded,
                      color: AppColors.accentBlue, size: 18),
                  const SizedBox(width: 8),
                  Text(
                    'Last 7 days  •  ${_history.length} sensors',
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: _fetchHistory,
                    child: const Icon(Icons.refresh_rounded,
                        color: AppColors.accentBlue, size: 20),
                  ),
                ],
              ),
              const SizedBox(height: 12),

              // One card per sensor
              for (final h in _history) ...[
                _SensorChartCard(history: h),
                const SizedBox(height: 12),
              ],
            ],
          ),
        );
      },
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /// Keeps at most [maxPoints] evenly-spaced items from [list].
  static List<T> _downsample<T>(List<T> list, int maxPoints) {
    if (list.length <= maxPoints) return list;
    final step = list.length / maxPoints;
    return List.generate(
      maxPoints,
      (i) => list[(i * step).floor()],
    );
  }
}

// ── Data model ────────────────────────────────────────────────────────────────

class _SensorHistory {
  final String     sensorType;
  final String     label;
  final String     unit;
  final List<FlSpot> spots;
  final double     minVal;
  final double     maxVal;
  final double     avgVal;
  final DateTime   startTime;

  const _SensorHistory({
    required this.sensorType,
    required this.label,
    required this.unit,
    required this.spots,
    required this.minVal,
    required this.maxVal,
    required this.avgVal,
    required this.startTime,
  });
}

// ── Chart card ────────────────────────────────────────────────────────────────

class _SensorChartCard extends StatelessWidget {
  final _SensorHistory history;
  const _SensorChartCard({required this.history});

  @override
  Widget build(BuildContext context) {
    // Colour: blue by default, orange if spread is wide (high variance)
    final spread = history.maxVal - history.minVal;
    final lineColor = spread > history.avgVal * 0.5
        ? AppColors.statusConnecting
        : AppColors.accentBlue;

    return Container(
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
      ),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Title row
          Row(
            children: [
              Container(
                width: 8, height: 8,
                decoration: BoxDecoration(
                  color: lineColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  history.label,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                  ),
                ),
              ),
              Text(
                history.unit,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Line chart
          SizedBox(
            height: 100,
            child: LineChart(
              LineChartData(
                lineBarsData: [
                  LineChartBarData(
                    spots:       history.spots,
                    isCurved:    true,
                    curveSmoothness: 0.3,
                    color:       lineColor,
                    barWidth:    1.5,
                    dotData:     const FlDotData(show: false),
                    belowBarData: BarAreaData(
                      show:  true,
                      color: lineColor.withOpacity(0.08),
                    ),
                  ),
                ],
                gridData: FlGridData(
                  show: true,
                  drawVerticalLine: false,
                  getDrawingHorizontalLine: (_) => FlLine(
                    color: AppColors.divider,
                    strokeWidth: 0.6,
                  ),
                ),
                borderData: FlBorderData(show: false),
                titlesData: FlTitlesData(
                  leftTitles: AxisTitles(
                    sideTitles: SideTitles(
                      showTitles: true,
                      reservedSize: 40,
                      interval: _niceInterval(history.maxVal - history.minVal),
                      getTitlesWidget: (value, meta) => Text(
                        _formatValue(value),
                        style: const TextStyle(
                          color: AppColors.textLabel,
                          fontSize: 9,
                        ),
                      ),
                    ),
                  ),
                  bottomTitles: AxisTitles(
                    sideTitles: SideTitles(
                      showTitles: true,
                      reservedSize: 18,
                      interval: 1440, // one label per day (1440 min)
                      getTitlesWidget: (value, meta) {
                        final date = history.startTime
                            .add(Duration(minutes: value.toInt()));
                        return Text(
                          _dayLabel(date),
                          style: const TextStyle(
                            color: AppColors.textLabel,
                            fontSize: 9,
                          ),
                        );
                      },
                    ),
                  ),
                  topTitles:   const AxisTitles(
                      sideTitles: SideTitles(showTitles: false)),
                  rightTitles: const AxisTitles(
                      sideTitles: SideTitles(showTitles: false)),
                ),
                lineTouchData: LineTouchData(
                  touchTooltipData: LineTouchTooltipData(
                    getTooltipColor: (_) => AppColors.bgCardAlt,
                    getTooltipItems: (spots) => spots.map((s) =>
                      LineTooltipItem(
                        '${_formatValue(s.y)} ${history.unit}',
                        const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 11,
                        ),
                      ),
                    ).toList(),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),

          // Min / Avg / Max summary
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _Stat(label: 'Min',  value: _formatValue(history.minVal), unit: history.unit, color: AppColors.accentBlue),
              _Divider(),
              _Stat(label: 'Avg',  value: _formatValue(history.avgVal), unit: history.unit, color: AppColors.textPrimary),
              _Divider(),
              _Stat(label: 'Max',  value: _formatValue(history.maxVal), unit: history.unit, color: lineColor),
            ],
          ),
        ],
      ),
    );
  }

  // ── Format helpers ──────────────────────────────────────────────────────────

  static String _formatValue(double v) {
    if (v.abs() >= 1000) return v.toStringAsFixed(0);
    if (v.abs() >= 10)   return v.toStringAsFixed(1);
    return v.toStringAsFixed(2);
  }

  static String _dayLabel(DateTime d) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[d.weekday - 1];
  }

  static double _niceInterval(double range) {
    if (range <= 0) return 1;
    final raw = range / 3;
    final magnitude = pow(10, (log(raw) / ln10).floor()).toDouble();
    final normalized = raw / magnitude;
    final nice = normalized < 1.5 ? 1.0
        : normalized < 3.5 ? 2.0
        : normalized < 7.5 ? 5.0
        : 10.0;
    return nice * magnitude;
  }
}

// ── Small widgets ─────────────────────────────────────────────────────────────

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  final String unit;
  final Color  color;
  const _Stat({
    required this.label,
    required this.value,
    required this.unit,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(label,
            style: const TextStyle(
                color: AppColors.textLabel, fontSize: 10,
                letterSpacing: 0.8)),
        const SizedBox(height: 2),
        Text(
          '$value $unit',
          style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}

class _Divider extends StatelessWidget {
  @override
  Widget build(BuildContext context) =>
      Container(width: 1, height: 24, color: AppColors.divider);
}

class _EmptyState extends StatelessWidget {
  final IconData     icon;
  final String       title;
  final String       subtitle;
  final String?      actionLabel;
  final VoidCallback? onAction;

  const _EmptyState({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 72, height: 72,
              decoration: BoxDecoration(
                color: AppColors.accentBlue.withOpacity(0.10),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 34, color: AppColors.accentBlue),
            ),
            const SizedBox(height: 20),
            Text(title,
                style: const TextStyle(
                    color: AppColors.textPrimary, fontSize: 18,
                    fontWeight: FontWeight.bold),
                textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(subtitle,
                style: const TextStyle(
                    color: AppColors.textSecondary, fontSize: 14, height: 1.5),
                textAlign: TextAlign.center),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: onAction,
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: AppColors.accentBlue),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10)),
                  padding: const EdgeInsets.symmetric(
                      horizontal: 28, vertical: 12),
                ),
                child: Text(actionLabel!,
                    style:
                        const TextStyle(color: AppColors.accentBlue)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
