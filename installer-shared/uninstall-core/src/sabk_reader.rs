//! Authenticated seekable access to SABK v1 without a plaintext temporary file.
use aes::{cipher::{BlockEncrypt, KeyInit}, Aes256};
use ghash::{universal_hash::UniversalHash, GHash};
use sha2::Sha256;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

pub(crate) struct SabkReader {
    file: File,
    cipher: Aes256,
    nonce: [u8; 12],
    start: u64,
    length: u64,
    position: u64,
}

fn invalid(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }

impl SabkReader {
    pub(crate) fn new(mut file: File, password: &str) -> io::Result<Self> {
        let mut header = [0u8; 9];
        file.read_exact(&mut header)?;
        if &header[..5] != b"SABK\x01" { return Err(invalid("Unsupported SABK header.")); }
        let salt_length = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
        if !(1..=65536).contains(&salt_length) { return Err(invalid("Invalid SABK salt.")); }
        let mut salt = vec![0u8; salt_length];
        file.read_exact(&mut salt)?;
        let mut nonce = [0u8; 12];
        let mut tag = [0u8; 16];
        file.read_exact(&mut nonce)?;
        file.read_exact(&mut tag)?;
        let start = file.stream_position()?;
        let length = file.metadata()?.len().checked_sub(start).ok_or_else(|| invalid("Truncated SABK payload."))?;
        if length == 0 || length > (u32::MAX as u64 - 1) * 16 { return Err(invalid("SABK payload exceeds the GCM counter limit.")); }
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, 100000, &mut key);
        let cipher = Aes256::new_from_slice(&key).map_err(|_| invalid("Invalid SABK key."))?;
        key.fill(0);
        let mut h = aes::Block::default();
        cipher.encrypt_block(&mut h);
        let mut authentication = GHash::new(&h);
        let mut buffer = [0u8; 65536];
        let mut remaining = length;
        while remaining > 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..count])?;
            authentication.update_padded(&buffer[..count]);
            remaining -= count as u64;
        }
        let mut lengths = ghash::Block::default();
        lengths[8..].copy_from_slice(&(length * 8).to_be_bytes());
        authentication.update(&[lengths]);
        let computed = authentication.finalize();
        let mut mask = aes::Block::default();
        mask[..12].copy_from_slice(&nonce);
        mask[15] = 1;
        cipher.encrypt_block(&mut mask);
        let mismatch = tag.iter().zip(computed.iter().zip(mask.iter())).fold(0u8, |difference, (expected, (hash, mask))| difference | (expected ^ hash ^ mask));
        if mismatch != 0 { return Err(invalid("Incorrect password or damaged SABK archive.")); }
        file.seek(SeekFrom::Start(start))?;
        Ok(Self { file, cipher, nonce, start, length, position: 0 })
    }
}

impl Read for SabkReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = (self.length - self.position).min(output.len() as u64) as usize;
        if count == 0 { return Ok(0); }
        self.file.seek(SeekFrom::Start(self.start + self.position))?;
        let count = self.file.read(&mut output[..count])?;
        let mut processed = 0;
        while processed < count {
            let position = self.position + processed as u64;
            let offset = (position % 16) as usize;
            let counter = (position / 16 + 2) as u32;
            let mut block = aes::Block::default();
            block[..12].copy_from_slice(&self.nonce);
            block[12..].copy_from_slice(&counter.to_be_bytes());
            self.cipher.encrypt_block(&mut block);
            let take = (16 - offset).min(count - processed);
            for index in 0..take { output[processed + index] ^= block[offset + index]; }
            processed += take;
        }
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for SabkReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(value) => value as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
            SeekFrom::End(delta) => self.length as i128 + delta as i128,
        };
        if position < 0 || position > self.length as i128 { return Err(invalid("SABK seek is outside the payload.")); }
        self.position = position as u64;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{aead::Aead, Aes256Gcm, Nonce};

    #[test]
    fn authenticates_multiple_blocks_and_seeks_unaligned_plaintext() {
        let plaintext = (0..200_137).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        let nonce = [19u8; 12];
        let salt = b"stream-fixture";
        let mut key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"fixture-secret", salt, 100000, &mut key);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), plaintext.as_slice()).unwrap();
        let mut bytes = b"SABK\x01".to_vec();
        bytes.extend_from_slice(&(salt.len() as u32).to_le_bytes());
        bytes.extend_from_slice(salt);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&encrypted[encrypted.len() - 16..]);
        bytes.extend_from_slice(&encrypted[..encrypted.len() - 16]);
        let file = std::env::temp_dir().join(crate::random_id("sabk-seek").unwrap());
        std::fs::write(&file, &bytes).unwrap();
        let mut reader = SabkReader::new(File::open(&file).unwrap(), "fixture-secret").unwrap();
        for start in [0, 1, 15, 16, 65535, 65536, 123_457, 200_130] {
            reader.seek(SeekFrom::Start(start)).unwrap();
            let mut buffer = vec![0u8; (plaintext.len() - start as usize).min(8193)];
            reader.read_exact(&mut buffer).unwrap();
            assert_eq!(buffer, plaintext[start as usize..start as usize + buffer.len()]);
        }
        drop(reader);
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        std::fs::write(&file, &bytes).unwrap();
        assert!(SabkReader::new(File::open(&file).unwrap(), "fixture-secret").is_err());
        std::fs::remove_file(file).unwrap();
    }
}
