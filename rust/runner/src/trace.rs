//! The turn's span, exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Its
//! `traceparent` goes to the agent, so the agent's spans and the gate's nest under it.

use mohdel_thin_gate::tracing::parse_traceparent;
use opentelemetry::global;
use opentelemetry::trace::{Link, Span, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::TracerProvider;
use opentelemetry_sdk::{runtime, Resource};

pub fn init() -> bool {
    let endpoint = match std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        Ok(v) if !v.is_empty() => v,
        _ => return false,
    };
    let exporter = match SpanExporter::builder()
        .with_tonic()
        .with_endpoint(&endpoint)
        .build()
    {
        Ok(exporter) => exporter,
        Err(err) => {
            eprintln!("spore: traces will not be exported — {err}");
            return false;
        }
    };
    let service = std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "spore".to_string());
    let provider = TracerProvider::builder()
        .with_batch_exporter(exporter, runtime::TokioCurrentThread)
        .with_resource(Resource::new(vec![KeyValue::new("service.name", service)]))
        .build();
    global::set_tracer_provider(provider);
    true
}

pub struct Turn {
    span: global::BoxedSpan,
}

impl Turn {
    /// Under the first message it answers that carries a `traceparent`, linked to the others
    /// that do. A span has one parent, and the caller it belongs to is one who is tracing; a
    /// turn answering no traced message starts a trace of its own. Not the runner's own
    /// `TRACEPARENT`: that is whoever started the runner, and a turn it carries on to answers
    /// someone else.
    pub fn start(workspace: &str, traced: &[String]) -> Turn {
        let mut callers = traced.iter().filter_map(|t| parse_traceparent(t));
        let parent = match callers.next() {
            Some(first) => Context::new().with_remote_span_context(first),
            None => Context::new(),
        };
        let tracer = global::tracer("spore");
        let mut span = tracer
            .span_builder("spore.turn")
            .with_links(callers.map(Link::with_context).collect())
            .start_with_context(&tracer, &parent);
        span.set_attribute(KeyValue::new("spore.workspace", workspace.to_string()));
        Turn { span }
    }

    /// None when nothing is exported: an invalid context is no parent at all.
    pub fn traceparent(&self) -> Option<String> {
        let context = self.span.span_context();
        context.is_valid().then(|| {
            format!(
                "00-{}-{}-{:02x}",
                context.trace_id(),
                context.span_id(),
                context.trace_flags().to_u8()
            )
        })
    }

    pub fn end(mut self, cost: f64) {
        self.span.set_attribute(KeyValue::new("spore.cost", cost));
        self.span.end();
    }
}

/// Flushes what was exported; called once, after the last turn.
pub fn shutdown() {
    global::shutdown_tracer_provider();
}
