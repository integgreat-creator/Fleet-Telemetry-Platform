import 'package:flutter/foundation.dart';

/// Holds a pending invite token that was received via deep link or QR scan.
/// main.dart watches this and routes to InviteAcceptScreen when non-null.
class InviteProvider extends ChangeNotifier {
  String? _pendingToken;

  String? get pendingToken => _pendingToken;
  bool get hasPendingInvite => _pendingToken != null;

  void setPendingToken(String token) {
    _pendingToken = token;
    notifyListeners();
  }

  void clearToken() {
    _pendingToken = null;
    notifyListeners();
  }
}
