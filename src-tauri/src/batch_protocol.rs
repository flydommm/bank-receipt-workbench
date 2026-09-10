//! Bounded worker frames and deadlines. Heartbeats never extend work limits.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
use std::io::BufRead;
use std::time::{Duration, Instant};

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerEvent {
    pub protocol: u64,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub generation: u64,
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Map<String, Value>,
}

struct StrictJson(usize);

impl<'de> DeserializeSeed<'de> for StrictJson {
    type Value = Value;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.0 > 16 {
            return Err(de::Error::custom("worker frame is too deeply nested"));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for StrictJson {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("bounded worker JSON")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom("worker integer is out of range"));
        }
        Ok(value.into())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        if value > MAX_SAFE_INTEGER {
            return Err(E::custom("worker integer is out of range"));
        }
        Ok(value.into())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        // serde_json may route an oversized integer token through visit_f64.
        // Use the same bound for both numeric representations on both sides.
        if value.abs() > MAX_SAFE_INTEGER as f64 {
            return Err(E::custom("worker number is out of range"));
        }
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("worker number is not finite"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(value) = values.next_element_seed(StrictJson(self.0 + 1))? {
            if result.len() >= 1024 {
                return Err(de::Error::custom("worker array is too large"));
            }
            result.push(value);
        }
        Ok(Value::Array(result))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut values: A) -> Result<Value, A::Error> {
        let mut result = Map::new();
        while let Some(key) = values.next_key::<String>()? {
            if result.len() >= 1024 || key.chars().count() > 256 || result.contains_key(&key) {
                return Err(de::Error::custom(
                    "worker object has invalid or duplicate keys",
                ));
            }
            result.insert(key, values.next_value_seed(StrictJson(self.0 + 1))?);
        }
        Ok(Value::Object(result))
    }
}

pub fn read_event<R: BufRead>(reader: &mut R) -> Result<Option<WorkerEvent>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "worker event could not be read")?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("worker frame ended without newline".into())
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err("worker frame exceeds the byte limit".into());
        }
        let complete = available[take - 1] == b'\n';
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            break;
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(&line);
    let value = StrictJson(0)
        .deserialize(&mut decoder)
        .map_err(|_| "worker frame is invalid JSON")?;
    decoder
        .end()
        .map_err(|_| "worker frame contains trailing data")?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| "worker event envelope is invalid".into())
}

pub struct EventSession {
    job_id: String,
    generation: u64,
    next_seq: u64,
    unit: Option<String>,
    deadline: Instant,
    timeout: Duration,
    completed: bool,
}

impl EventSession {
    pub fn new(
        job_id: String,
        generation: u64,
        now: Instant,
        timeout: Duration,
    ) -> Result<Self, String> {
        if job_id.is_empty()
            || job_id.len() > 128
            || job_id.contains('\0')
            || generation == 0
            || generation > MAX_SAFE_INTEGER
            || timeout.is_zero()
        {
            return Err("worker session identity is invalid".into());
        }
        let deadline = now.checked_add(timeout).ok_or("worker deadline overflow")?;
        Ok(Self {
            job_id,
            generation,
            next_seq: 1,
            unit: None,
            deadline,
            timeout,
            completed: false,
        })
    }

    pub fn timed_out(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    pub fn accept(&mut self, event: &WorkerEvent, now: Instant) -> Result<(), String> {
        if self.completed
            || event.protocol != 2
            || event.job_id != self.job_id
            || event.generation != self.generation
            || event.seq != self.next_seq
            || event.seq > MAX_SAFE_INTEGER
        {
            return Err("worker event identity or sequence is invalid".into());
        }
        if self.timed_out(now) {
            return Err("worker work unit timed out".into());
        }
        match event.event_type.as_str() {
            "snapshot" | "state_changed" | "page_failed" => {}
            "completed" => {
                if self.unit.is_some() {
                    return Err("worker completed with an unfinished unit".into());
                }
                if !matches!(
                    event.payload.get("state").and_then(Value::as_str),
                    Some(
                        "ready_for_review"
                            | "paused"
                            | "partial_failed"
                            | "blocked"
                            | "cancel_requested"
                            | "cancelled"
                            | "interrupted"
                    )
                ) {
                    return Err("worker terminal state is invalid".into());
                }
                self.completed = true;
            }
            "progress" => match event.payload.get("phase").and_then(Value::as_str) {
                Some("heartbeat" | "page_settled") => {}
                Some(phase @ ("unit_start" | "unit_end")) => {
                    let id = event
                        .payload
                        .get("unit_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty() && id.len() <= 128 && !id.contains('\0'))
                        .ok_or("worker unit identity is invalid")?;
                    if phase == "unit_start" {
                        if self.unit.is_some()
                            || !matches!(
                                event.payload.get("stage").and_then(Value::as_str),
                                Some(
                                    "validating"
                                        | "source_open"
                                        | "page"
                                        | "final_source_verification"
                                        | "assembling"
                                )
                            )
                        {
                            return Err("worker unit start is invalid".into());
                        }
                        self.unit = Some(id.into());
                    } else {
                        if self.unit.as_deref() != Some(id) {
                            return Err("worker unit end is stale".into());
                        }
                        self.unit = None;
                    }
                    self.deadline = now
                        .checked_add(self.timeout)
                        .ok_or("worker deadline overflow")?;
                }
                _ => return Err("worker progress phase is invalid".into()),
            },
            _ => return Err("worker event type is invalid".into()),
        }
        self.next_seq += 1;
        Ok(())
    }

    pub fn completed(&self) -> bool {
        self.completed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn event(seq: u64, phase: &str) -> WorkerEvent {
        serde_json::from_value(
            json!({"protocol":2,"jobId":"job","generation":1,"seq":seq,"type":"progress",
            "payload":{"phase":phase,"unit_id":"unit","stage":"page"}}),
        )
        .unwrap()
    }

    #[test]
    fn heartbeat_does_not_extend_the_same_work_unit_deadline() {
        let now = Instant::now();
        let mut session =
            EventSession::new("job".into(), 1, now, Duration::from_secs(120)).unwrap();
        session.accept(&event(1, "unit_start"), now).unwrap();
        session
            .accept(&event(2, "heartbeat"), now + Duration::from_secs(119))
            .unwrap();
        assert!(session.timed_out(now + Duration::from_secs(120)));
        assert!(session
            .accept(&event(3, "unit_end"), now + Duration::from_secs(121))
            .is_err());
    }

    #[test]
    fn every_new_unit_has_its_own_deadline_and_strict_sequence() {
        let now = Instant::now();
        let mut session =
            EventSession::new("job".into(), 1, now, Duration::from_secs(120)).unwrap();
        session.accept(&event(1, "unit_start"), now).unwrap();
        session
            .accept(&event(2, "unit_end"), now + Duration::from_secs(110))
            .unwrap();
        session
            .accept(&event(3, "unit_start"), now + Duration::from_secs(111))
            .unwrap();
        assert!(!session.timed_out(now + Duration::from_secs(200)));
        assert!(session
            .accept(&event(3, "heartbeat"), now + Duration::from_secs(112))
            .is_err());
        let mut wrong_generation = event(4, "heartbeat");
        wrong_generation.generation = 2;
        assert!(session
            .accept(&wrong_generation, now + Duration::from_secs(112))
            .is_err());
    }

    #[test]
    fn malformed_frames_are_rejected_without_returning_input() {
        for line in [
            "{}", "{\"secret\":NaN}\n", "[]\n", "{} {}\n",
            "{\"protocol\":2,\"jobId\":\"job\",\"generation\":1,\"seq\":1,\"type\":\"progress\",\"payload\":{\"x\":0,\"x\":1}}\n",
            "{\"protocol\":2.0,\"jobId\":\"job\",\"generation\":1,\"seq\":1,\"type\":\"progress\",\"payload\":{}}\n",
        ] {
            assert!(read_event(&mut Cursor::new(line)).is_err());
        }
        assert!(read_event(&mut Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1])).is_err());
    }

    #[test]
    fn numeric_limits_also_cover_integers_decoded_as_floats() {
        for number in [
            "9007199254740992",
            "18446744073709551616",
            "-18446744073709551616",
            "99999999999999999999999999999999999999999999999999",
            "1e30",
        ] {
            let line = format!("{{\"protocol\":2,\"jobId\":\"job\",\"generation\":1,\"seq\":1,\"type\":\"progress\",\"payload\":{{\"counter\":{number}}}}}\n");
            assert!(read_event(&mut Cursor::new(line)).is_err());
        }
        let line = "{\"protocol\":2,\"jobId\":\"job\",\"generation\":1,\"seq\":1,\"type\":\"progress\",\"payload\":{\"fraction\":0.125}}\n";
        assert!(read_event(&mut Cursor::new(line)).unwrap().is_some());
    }

    #[test]
    fn ordered_reader_preserves_multiple_events_and_clean_eof() {
        let mut bytes = serde_json::to_vec(&event(1, "heartbeat")).unwrap();
        bytes.push(b'\n');
        bytes.extend(serde_json::to_vec(&event(2, "heartbeat")).unwrap());
        bytes.push(b'\n');
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_event(&mut cursor).unwrap().unwrap().seq, 1);
        assert_eq!(read_event(&mut cursor).unwrap().unwrap().seq, 2);
        assert!(read_event(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn completion_requires_finished_units_and_rejects_later_events() {
        let now = Instant::now();
        let mut session =
            EventSession::new("job".into(), 1, now, Duration::from_secs(120)).unwrap();
        let mut done = event(2, "heartbeat");
        done.event_type = "completed".into();
        done.payload = json!({"state":"ready_for_review"})
            .as_object()
            .unwrap()
            .clone();
        session.accept(&event(1, "unit_start"), now).unwrap();
        assert!(session.accept(&done, now).is_err());
        assert!(!session.completed());
        session.accept(&event(2, "unit_end"), now).unwrap();
        done.seq = 3;
        session.accept(&done, now).unwrap();
        assert!(session.completed());
        assert!(session.accept(&event(4, "heartbeat"), now).is_err());
    }
}
