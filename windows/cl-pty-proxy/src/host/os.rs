//! #3425 — what the session host does differently per system: where its
//! clients reach it, who may read its folder, how the command's processes are
//! held together, and how it leaves the daemon behind.
//!
//! Unix: a Unix socket at the path (mode 0600, folder 0700), the command's
//! process group, and a scope the daemon starts it in (src/sessions/hosts.ts).
//!
//! Windows has no Unix sockets a client of every kind can reach, so the host
//! listens on the loopback, on a port the system picks, and writes
//! `{ "port", "token" }` to `<path>.addr` beside where the socket would be
//! (docs/SESSION-HOST.md). A loopback port is open to every local process: the
//! token is what a client must say (`hello` on attach, `host.auth` on
//! control), and the folder's ACL is what keeps it to its user. The command
//! runs in a job of its own, which is how its children go with it, and the
//! host leaves the daemon's job as it starts (`--detach`).

use std::io;
use std::path::Path;

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
#[cfg(windows)]
pub use std::net::{TcpListener as Listener, TcpStream as Stream};

/// The address file beside a socket's path.
#[cfg_attr(unix, allow(dead_code))]
pub fn addr_path(path: &Path) -> std::path::PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".addr");
    p.into()
}

/// A client's token against the host's, in time that does not depend on where they differ.
pub fn token_matches(given: Option<&str>, expected: &str) -> bool {
    let Some(given) = given else { return false };
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh token: 32 random bytes, in hex.
#[cfg_attr(unix, allow(dead_code))]
pub fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- Unix --------------------------------------------------------------------

/// Listen at `path`; no token (the socket's mode is the access).
#[cfg(unix)]
pub fn listen(path: &Path) -> io::Result<(Listener, Option<String>)> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(path);
    let l = Listener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok((l, None))
}

/// The host's folder, readable by its user alone.
#[cfg(unix)]
pub fn make_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(unix)]
pub fn no_delay(_s: &Stream) {}

// ---- Windows -----------------------------------------------------------------

/// Listen on the loopback and write where, with the token, to `<path>.addr`.
#[cfg(windows)]
pub fn listen(path: &Path) -> io::Result<(Listener, Option<String>)> {
    let l = Listener::bind(("127.0.0.1", 0))?;
    let port = l.local_addr()?.port();
    let token = new_token()?;
    let addr = addr_path(path);
    let mut tmp = addr.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, serde_json::json!({ "port": port, "token": token }).to_string())?;
    std::fs::rename(&tmp, &addr)?;
    Ok((l, Some(token)))
}

/// Small frames and lines both ways: sent at once, not held back to fill a packet.
#[cfg(windows)]
pub fn no_delay(s: &Stream) {
    let _ = s.set_nodelay(true);
}

#[cfg(windows)]
fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// The host's folder with a protected ACL: full access for this user, nobody
/// else, nothing inherited from above. What the host writes in it afterwards
/// (the address files, host.json) inherits that. The folder's place gives no
/// protection of its own: an install outside the profile (`-Prefix`,
/// `%PROGRAMDATA%`) inherits whatever its parent allows.
#[cfg(windows)]
pub fn make_private_dir(dir: &Path) -> io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    std::fs::create_dir_all(dir)?;
    unsafe {
        // This process's user, as a SID string.
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_str: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_str) == 0 {
            return Err(io::Error::last_os_error());
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_str, (0..).take_while(|&i| *sid_str.add(i) != 0).count()));
        LocalFree(sid_str.cast());

        // D:P — a protected DACL; OICI — files and folders below inherit it; FA — full access.
        let sddl = wide(std::ffi::OsStr::new(&format!("D:P(A;OICI;FA;;;{sid})")));
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(io::Error::last_os_error());
        }
        let path = wide(dir.as_os_str());
        let ok = SetFileSecurityW(path.as_ptr(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, sd);
        LocalFree(sd);
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The command's processes, held together: what the process group is on Unix.
/// Closing the job's last handle ends every process in it, so the command and
/// what it started go with the host, whichever way the host ends.
#[cfg(windows)]
pub struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// A job for `pid`, ending everything in it when dropped. The processes the
    /// command starts from now on are in it; one started in the instant before
    /// is not, and ends as the console closes.
    pub fn for_pid(pid: u32) -> io::Result<Job> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                return Err(io::Error::last_os_error());
            }
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return Err(io::Error::last_os_error());
            }
            let ok = AssignProcessToJobObject(job.0, proc);
            CloseHandle(proc);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    /// End every process in the job now.
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// `--detach`: start this host again, out of the caller's job and console,
/// and say how it went. The daemon may run in a job that ends every process in
/// it when it closes: a host left there would die with it, the Claude in it
/// too. Breaking away is refused when the job does not allow it: the host then
/// starts in it all the same, and says so. #3467 — the usual case is the Task
/// Scheduler's job (the tray started at logon), which refuses breaking away but
/// ends nothing when the task ends, is deleted or is stopped: there the host
/// lives on. What systemd-run --scope does on Linux. The new host's pid, and
/// whether it left the job.
#[cfg(windows)]
pub fn detach(args: &[String]) -> io::Result<(u32, bool)> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

    let exe = std::env::current_exe()?;
    let spawn = |flags: u32| {
        Command::new(&exe)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    match spawn(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(child) => Ok((child.id(), true)),
        Err(e) => {
            eprintln!("cl-session-host: cannot leave the caller's job ({e}): the host starts in it, and ends only if that job ends its processes");
            spawn(base).map(|c| (c.id(), false))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_matches_only_itself() {
        assert!(token_matches(Some("abc"), "abc"));
        assert!(!token_matches(Some("abd"), "abc"));
        assert!(!token_matches(Some("ab"), "abc"));
        assert!(!token_matches(Some(""), "abc"));
        assert!(!token_matches(None, "abc"));
    }

    #[test]
    fn a_token_is_64_hex_digits_and_fresh() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_address_file_sits_beside_the_socket() {
        assert_eq!(addr_path(Path::new("/h/a/attach.sock")), Path::new("/h/a/attach.sock.addr"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_listener_publishes_its_port_and_token() {
        let dir = std::env::temp_dir().join(format!("clsh-os-{}", std::process::id()));
        make_private_dir(&dir).unwrap();
        let sock = dir.join("attach.sock");
        let (l, token) = listen(&sock).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(addr_path(&sock)).unwrap()).unwrap();
        assert_eq!(v["port"].as_u64().unwrap() as u16, l.local_addr().unwrap().port());
        assert_eq!(v["token"].as_str(), token.as_deref());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
