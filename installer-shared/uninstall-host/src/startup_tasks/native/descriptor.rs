//! Structural validation of the administrator startup task security boundary.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, BOOL, HLOCAL};
use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows::Win32::Security::*;

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) { unsafe { let _ = LocalFree(HLOCAL(self.0.0)); } }
}

fn parse(value: &str) -> windows::core::Result<Descriptor> {
    let wide = value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(wide.as_ptr()), 1, &mut descriptor, None)?; }
    Ok(Descriptor(descriptor))
}

unsafe fn entries(descriptor: &Descriptor) -> windows::core::Result<Vec<(u32, PSID)>> {
    let mut present = BOOL::default(); let mut defaulted = BOOL::default(); let mut acl = std::ptr::null_mut();
    GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted)?;
    if !present.as_bool() || defaulted.as_bool() || acl.is_null() || (*acl).AceCount != 3 {
        return Err(windows::core::Error::from_win32());
    }
    let mut entries = Vec::new();
    for index in 0..(*acl).AceCount {
        let mut raw = std::ptr::null_mut(); GetAce(acl, index.into(), &mut raw)?;
        let ace = &*raw.cast::<ACCESS_ALLOWED_ACE>();
        if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 {
            return Err(windows::core::Error::from_win32());
        }
        let mask = if ace.Mask == 0xa0000000 { 1179817 } else { ace.Mask };
        entries.push((mask, PSID(std::ptr::addr_of!(ace.SidStart).cast_mut().cast())));
    }
    Ok(entries)
}

pub(super) fn valid(sddl: &str, sid: &str) -> bool {
    let expected = format!("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;{sid})");
    let (Ok(actual), Ok(expected)) = (parse(sddl), parse(&expected)) else { return false; };
    unsafe {
        let compare = || -> windows::core::Result<bool> {
            let mut actual_control = 0; let mut expected_control = 0; let mut revision = 0;
            GetSecurityDescriptorControl(actual.0, &mut actual_control, &mut revision)?;
            GetSecurityDescriptorControl(expected.0, &mut expected_control, &mut revision)?;
            if actual_control & !SE_DACL_AUTO_INHERITED.0 != expected_control { return Ok(false); }
            let mut left = PSID::default(); let mut right = PSID::default(); let mut defaulted = BOOL::default();
            GetSecurityDescriptorOwner(actual.0, &mut left, &mut defaulted)?;
            GetSecurityDescriptorOwner(expected.0, &mut right, &mut defaulted)?;
            EqualSid(left, right)?;
            GetSecurityDescriptorGroup(actual.0, &mut left, &mut defaulted)?;
            GetSecurityDescriptorGroup(expected.0, &mut right, &mut defaulted)?;
            EqualSid(left, right)?;
            let mut remaining = entries(&expected)?;
            for (mask, sid) in entries(&actual)? {
                let Some(index) = remaining.iter().position(|(other_mask, other_sid)| *other_mask == mask && EqualSid(*other_sid, sid).is_ok()) else { return Ok(false); };
                remaining.remove(index);
            }
            Ok(remaining.is_empty())
        };
        compare().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descriptor_accepts_equivalent_order_and_rejects_broader_authority() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert!(valid(&format!("O:BAG:BAD:PAI(A;;0x1200a9;;;{sid})(A;;FA;;;BA)(A;;FA;;;SY)"), sid));
        for value in [
            format!("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})"),
            format!("O:BAG:BAD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;{sid})"),
            format!("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;WD)"),
            format!("O:{sid}G:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;{sid})"),
        ] { assert!(!valid(&value, sid)); }
    }
}
