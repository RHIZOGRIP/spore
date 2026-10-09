//! The store socket: the vector store behind the tree key, for `memory: vectors`. The agent
//! embeds on the model socket and brings vectors; this holds the store's credential and pins the
//! collection to the workspace and to the definition's embedding model.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::{not_found_response, Body};
use serde_json::{json, Value};

use crate::broker::{answer, read_json, Refusal};
use crate::vectors::{batches_of, sha256_hex, VectorStore};

pub const UNIT_FIELD: &str = "unit";

pub struct Store {
    vectors: VectorStore,
    wsid: String,
    model: String,
    provisioned: Mutex<HashSet<String>>,
}

fn malformed(detail: impl Into<String>) -> Refusal {
    Refusal::new(
        StatusCode::BAD_REQUEST,
        "PROTOCOL_INVALID_REQUEST",
        "malformed store request",
        detail,
    )
}

fn dimensions_of(body: &Value) -> Result<u64, Refusal> {
    body["dimensions"]
        .as_u64()
        .filter(|d| *d > 0)
        .ok_or_else(|| malformed("dimensions is the collection's width, a whole number above zero"))
}

fn text_of<'a>(body: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    body[key]
        .as_str()
        .ok_or_else(|| malformed(format!("{key} is a string")))
}

fn vector_of(value: &Value, dimensions: u64) -> Result<Vec<f64>, Refusal> {
    let components = value
        .as_array()
        .ok_or_else(|| malformed("a vector is an array of numbers"))?;
    let vector = components
        .iter()
        .map(Value::as_f64)
        .collect::<Option<Vec<f64>>>()
        .ok_or_else(|| malformed("a vector is an array of numbers"))?;
    if vector.len() as u64 != dimensions {
        return Err(Refusal::new(
            StatusCode::BAD_REQUEST,
            "STORE_DIMENSION_MISMATCH",
            format!(
                "a vector of {} dimensions where the collection holds {dimensions}",
                vector.len()
            ),
            "every vector in a collection has its width; embed with the definition's memory model",
        ));
    }
    Ok(vector)
}

impl Store {
    pub fn new(vectors: VectorStore, workspace: &Path, model: &str) -> Arc<Store> {
        let named = json!(["workspace", workspace.to_string_lossy()]).to_string();
        Arc::new(Store {
            vectors,
            wsid: sha256_hex(&named)[..32].to_string(),
            model: model.to_string(),
            provisioned: Mutex::default(),
        })
    }

    fn collection(&self, dimensions: u64) -> String {
        let space = sha256_hex(&format!("{}@{dimensions}", self.model));
        format!("spore-{}-{}", self.wsid, &space[..8])
    }

    async fn ensure(&self, dimensions: u64) -> Result<String, Refusal> {
        let collection = self.collection(dimensions);
        if self
            .provisioned
            .lock()
            .expect("provisioned")
            .contains(&collection)
        {
            return Ok(collection);
        }
        self.vectors
            .ensure_collection(
                &collection,
                json!({ "dimensions": dimensions, "metric": "cosine", "embedding_space": self.model }),
                json!({ UNIT_FIELD: { "type": "string", "filterable": true } }),
            )
            .await?;
        self.provisioned
            .lock()
            .expect("provisioned")
            .insert(collection.clone());
        Ok(collection)
    }

    async fn holds(&self, body: Value) -> Result<Value, Refusal> {
        let dimensions = dimensions_of(&body)?;
        let ids = body["ids"]
            .as_array()
            .and_then(|ids| ids.iter().map(Value::as_str).collect::<Option<Vec<&str>>>())
            .ok_or_else(|| malformed("ids is an array of strings"))?;
        if ids.is_empty() {
            return Ok(json!({ "held": [] }));
        }
        let collection = self.ensure(dimensions).await?;
        let held = self.vectors.holds(&collection, &ids).await?;
        let held: Vec<&str> = ids.into_iter().filter(|id| held.contains(*id)).collect();
        Ok(json!({ "held": held }))
    }

    async fn index(&self, body: Value) -> Result<Value, Refusal> {
        let dimensions = dimensions_of(&body)?;
        let unit = text_of(&body, "unit")?;
        let given = body["records"]
            .as_array()
            .ok_or_else(|| malformed("records is an array of { id, vector }"))?;
        let records = given
            .iter()
            .map(|record| -> Result<Value, Refusal> {
                let id = text_of(record, "id")?;
                let vector = vector_of(&record["vector"], dimensions)?;
                Ok(json!({ "id": id, "vector": vector, "metadata": { UNIT_FIELD: unit } }))
            })
            .collect::<Result<Vec<Value>, Refusal>>()?;
        if records.is_empty() {
            return Ok(json!({ "indexed": 0 }));
        }
        let indexed = records.len();
        let batches = batches_of(records)?;
        let collection = self.ensure(dimensions).await?;
        for batch in batches {
            self.vectors.upsert(&collection, &batch).await?;
        }
        Ok(json!({ "indexed": indexed }))
    }

    async fn search(&self, body: Value) -> Result<Value, Refusal> {
        let dimensions = dimensions_of(&body)?;
        let unit = text_of(&body, "unit")?;
        let vector = vector_of(&body["vector"], dimensions)?;
        let top_k = body["topK"]
            .as_u64()
            .filter(|k| *k > 0)
            .ok_or_else(|| malformed("topK is a whole number above zero"))?;
        let collection = self.ensure(dimensions).await?;
        let matches = self
            .vectors
            .query(
                &collection,
                &vector,
                top_k,
                Some(json!({ "eq": { "field": UNIT_FIELD, "value": unit } })),
            )
            .await?;
        let matches: Vec<Value> = matches
            .iter()
            .map(|m| json!({ "id": m["id"], "distance": m["distance"] }))
            .collect();
        Ok(json!({ "matches": matches }))
    }

    pub async fn route(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let (method, path) = (req.method().clone(), req.uri().path().to_string());
        if method != Method::POST || !matches!(path.as_str(), "/holds" | "/index" | "/search") {
            return not_found_response(&method, &path);
        }
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(refusal) => return refusal.response(),
        };
        answer(match path.as_str() {
            "/holds" => self.holds(body).await,
            "/index" => self.index(body).await,
            _ => self.search(body).await,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors::fake::{serve, store as vectors, Fake};

    async fn store(model: &str) -> (Fake, Arc<Store>) {
        let fake = serve(|seen, _| {
            let body = if seen.path.ends_with("/query") {
                json!({ "matches": [{ "id": "a", "distance": 0.5, "version": 3 }] })
            } else if seen.path.ends_with("records:fetch") {
                json!({ "records": [{ "id": "b" }] })
            } else {
                json!({})
            };
            (200, body.to_string())
        })
        .await;
        let (r, _) = vectors(&fake);
        let store = Store::new(r, Path::new("/home/me/spores/a"), model);
        (fake, store)
    }

    #[tokio::test]
    async fn sends_a_changed_embedding_model_or_width_to_its_own_collection() {
        let (_, a) = store("acme/embed-1").await;
        let (_, b) = store("acme/embed-2").await;
        assert!(a
            .collection(1536)
            .starts_with(&format!("spore-{}-", a.wsid)));
        assert_eq!(a.wsid.len(), 32);
        assert_ne!(a.collection(1536), b.collection(1536));
        assert_ne!(a.collection(1536), a.collection(768));
        assert_eq!(a.collection(1536), a.collection(1536));
    }

    #[tokio::test]
    async fn refuses_a_vector_of_the_wrong_width_before_anything_reaches_the_store() {
        let (fake, store) = store("acme/embed").await;
        let refused = store
            .index(json!({
                "dimensions": 3,
                "unit": "sentence",
                "records": [{ "id": "a", "vector": [1, 0, 0] }, { "id": "b", "vector": [1, 0] }]
            }))
            .await
            .unwrap_err();
        assert_eq!(refused.kind, "STORE_DIMENSION_MISMATCH");
        assert!(
            refused.message.contains("2 dimensions"),
            "{}",
            refused.message
        );
        assert!(fake.seen().is_empty());
    }

    #[tokio::test]
    async fn creates_the_collection_once_and_tags_each_record_with_its_unit() {
        let (fake, store) = store("acme/embed").await;
        let indexed = store
            .index(json!({
                "dimensions": 2,
                "unit": "turn",
                "records": [{ "id": "a", "vector": [1, 0] }, { "id": "b", "vector": [0, 1] }]
            }))
            .await
            .unwrap();
        assert_eq!(indexed, json!({ "indexed": 2 }));
        store
            .holds(json!({ "dimensions": 2, "ids": ["a", "b"] }))
            .await
            .unwrap();
        let seen = fake.seen();
        let paths: Vec<&str> = seen.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(paths[0], "/v1/collections");
        assert_eq!(paths.iter().filter(|p| **p == "/v1/collections").count(), 1);
        assert_eq!(
            seen[0].body["vector_schema"]["embedding_space"],
            "acme/embed"
        );
        assert_eq!(seen[0].body["vector_schema"]["dimensions"], 2);
        assert_eq!(seen[1].body["records"][1]["metadata"]["unit"], "turn");
    }

    #[tokio::test]
    async fn answers_which_ids_the_collection_already_holds() {
        let (_, store) = store("acme/embed").await;
        let held = store
            .holds(json!({ "dimensions": 2, "ids": ["a", "b", "c"] }))
            .await
            .unwrap();
        assert_eq!(held, json!({ "held": ["b"] }));
    }

    #[tokio::test]
    async fn keeps_the_units_apart_so_a_sentence_query_never_ranks_turns() {
        let (fake, store) = store("acme/embed").await;
        let found = store
            .search(json!({ "dimensions": 2, "unit": "sentence", "vector": [1, 0], "topK": 5 }))
            .await
            .unwrap();
        assert_eq!(
            found,
            json!({ "matches": [{ "id": "a", "distance": 0.5 }] })
        );
        let query = fake.seen().pop().unwrap();
        assert_eq!(
            query.body["filter"],
            json!({ "eq": { "field": "unit", "value": "sentence" } })
        );
        assert_eq!(query.body["top_k"], 5);
    }

    #[tokio::test]
    async fn refuses_a_request_missing_what_it_needs() {
        let (fake, store) = store("acme/embed").await;
        let refused = store
            .search(json!({ "unit": "sentence", "vector": [1, 0], "topK": 5 }))
            .await
            .unwrap_err();
        assert_eq!(refused.kind, "PROTOCOL_INVALID_REQUEST");
        let refused = store
            .holds(json!({ "dimensions": 2, "ids": ["a", 3] }))
            .await
            .unwrap_err();
        assert_eq!(refused.kind, "PROTOCOL_INVALID_REQUEST");
        assert!(fake.seen().is_empty());
    }
}
