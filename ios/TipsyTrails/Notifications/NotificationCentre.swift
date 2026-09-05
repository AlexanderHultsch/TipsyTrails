import Foundation
import UserNotifications

// ios/SPEC.md Section 7.7: the `UNUserNotificationCenter` work that is not
// already in Runtime/HostBridge.swift. `HostBridge`'s `installScheduleNotification`
// and `installCancelNotification` already schedule and cancel every one of
// Section 7.7's four notifications directly through
// `UNUserNotificationCenter.current()` - that is not moved here, and this
// file adds only the two things that file does not do: requesting
// authorization, and reporting the authorization the app currently holds -
// plus the delegate that lets a notification scheduled while the app is in
// the foreground still present, which neither file had a home for before
// this one existed.
final class NotificationCentre: NSObject {
    // Section 7.7's third rule: "Permission is asked from the Consent
    // screen and never on launch." This method's only intended caller is
    // Screens/'s Consent screen (F3, not yet built); nothing in App/ calls
    // it at launch, and nothing here calls it either.
    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                completion(granted)
            }
        }
    }

    // Section 11.2/11.3: the Consent screen shows "the current state of...
    // notification permission" and the Diagnostics screen shows "the
    // authorization pair" alongside it - both read this rather than asking
    // iOS again themselves.
    func currentAuthorizationStatus(completion: @escaping (UNAuthorizationStatus) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                completion(settings.authorizationStatus)
            }
        }
    }
}

extension NotificationCentre: UNUserNotificationCenterDelegate {
    // Without this, a notification `HostBridge` schedules while the app
    // happens to be in the foreground would be silently swallowed - the
    // system default is to suppress a notification's banner while its own
    // app is frontmost, and Section 7.7's four are exactly the kind of
    // event a player wants to see whether or not the app is open at the
    // moment it happens.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }
}
