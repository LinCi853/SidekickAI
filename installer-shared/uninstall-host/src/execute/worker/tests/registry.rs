//! Registry cleanup tests.

use super::*;

    #[cfg(windows)]
    #[test]
    fn registry_cleanup_matches_selected_directory_and_command_across_editions() {
        use winreg::{RegKey, enums::*};
        let key_path = format!(r"Software\SidekickAI-CleanupTest-{}", random_nonce().unwrap());
        struct Guard(String);
        impl Drop for Guard { fn drop(&mut self) { let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0); } }
        let _guard = Guard(key_path.clone());
        let parent = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&key_path).unwrap().0;
        let selected = Path::new(r"C:\Fixture\Selected");
        let other = Path::new(r"C:\Fixture\Unselected");
        for (name, path, correct_command) in [("Concept-Beta4", selected, true), ("Concept-Legacy", selected, true), ("Community", other, true), ("Unrelated", selected, false)] {
            let key = parent.create_subkey(name).unwrap().0;
            key.set_value("InstallLocation", &path.to_string_lossy().as_ref()).unwrap();
            let command = if correct_command { format!("\"{}\" --uninstall", path.join("uninstall.exe").display()) } else { "unrelated.exe".into() };
            key.set_value("UninstallString", &command).unwrap();
        }
        assert!(super::super::registry::remove_matching_registrations(&parent, selected, KEY_WOW64_64KEY).unwrap());
        assert!(parent.open_subkey("Concept-Beta4").is_err());
        assert!(parent.open_subkey("Concept-Legacy").is_err());
        assert!(parent.open_subkey("Community").is_ok());
        assert!(parent.open_subkey("Unrelated").is_ok());
    }

    /// Registration cleanup may only delete a key whose `InstallLocation` is
    /// explicit and matches the removed installation. The test uses a dedicated
    /// fixture key name, never the production `SidekickAI` registration.
    #[cfg(windows)]
    #[test]
    fn registry_cleanup_requires_an_explicit_matching_install_location() {
        use winreg::enums::*;
        use winreg::RegKey;
        let key_name = format!("SidekickAI-DelegatedTest-{}", random_nonce().unwrap());
        let _guard = FixtureRegistration(key_name.clone());
        let parent = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ | KEY_WRITE)
            .expect("the per-user uninstall list must exist");
        let fixture = std::env::temp_dir().join(format!("sidekick-reg-fixture-{}", random_nonce().unwrap()));
        let other = std::env::temp_dir().join(format!("sidekick-reg-other-{}", random_nonce().unwrap()));
        fs::create_dir_all(&fixture).unwrap();
        fs::create_dir_all(&other).unwrap();

        // Missing key: nothing to remove and no error.
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(false));

        // Empty InstallLocation is never enough to justify deletion.
        parent.create_subkey(&key_name).unwrap().0.set_value("InstallLocation", &String::new()).unwrap();
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(false));
        assert!(parent.open_subkey(&key_name).is_ok(), "an empty InstallLocation must leave the key intact");

        // A location that points at another installation is left intact.
        parent
            .open_subkey_with_flags(&key_name, KEY_WRITE)
            .unwrap()
            .set_value("InstallLocation", &other.to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(false));
        assert!(parent.open_subkey(&key_name).is_ok(), "another installation's key must survive");

        // Only an explicit matching location authorizes removal.
        parent
            .open_subkey_with_flags(&key_name, KEY_WRITE)
            .unwrap()
            .set_value("InstallLocation", &fixture.to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(true));
        assert!(parent.open_subkey(&key_name).is_err(), "a matching registration must be removed");

        // An unknown root is refused rather than guessed at.
        assert!(remove_registration_key("HKCR", &key_name, &fixture).is_err());

        let _ = fs::remove_dir_all(&fixture);
        let _ = fs::remove_dir_all(&other);
    }

    /// The registry match normalizes a trailing separator and case, but a
    /// whitespace-padded value is never silently trimmed into a match.
    #[cfg(windows)]
    #[test]
    fn registry_cleanup_normalizes_trailing_separator_and_case() {
        use winreg::enums::*;
        use winreg::RegKey;
        let key_name = format!("SidekickAI-DelegatedTest-{}", random_nonce().unwrap());
        let _guard = FixtureRegistration(key_name.clone());
        let parent = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ | KEY_WRITE)
            .expect("the per-user uninstall list must exist");
        let fixture = std::env::temp_dir().join(format!("sidekick-reg-case-{}", random_nonce().unwrap()));
        fs::create_dir_all(&fixture).unwrap();

        let with_separator = format!("{}\\", fixture.to_string_lossy()).to_uppercase();
        parent.create_subkey(&key_name).unwrap().0.set_value("InstallLocation", &with_separator).unwrap();
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(true));
        assert!(parent.open_subkey(&key_name).is_err(), "a trailing-separator, different-case match must be removed");

        parent
            .create_subkey(&key_name)
            .unwrap()
            .0
            .set_value("InstallLocation", &format!(" {} ", fixture.to_string_lossy()))
            .unwrap();
        assert_eq!(remove_registration_key("HKCU", &key_name, &fixture), Ok(false));
        assert!(parent.open_subkey(&key_name).is_ok(), "a whitespace-padded value must not be trimmed into a match");

        let _ = fs::remove_dir_all(&fixture);
    }
