//! What the runner and the cell supervisor share: the sockets they serve and how a spawn is
//! planned. Contract: ARCHITECTURE.md §The spore command.

pub mod broker;
pub mod dial;
pub mod enzymes;
pub mod job;
pub mod model;
pub mod plan;
pub mod source;
pub mod store;
pub mod supervise;
pub mod trace;
pub mod vectors;
