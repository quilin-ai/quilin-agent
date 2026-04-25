#![forbid(unsafe_code)]

//! Minimal Iter D Agent Mesh SDK stub.
//!
//! Runtime mesh behavior is intentionally deferred to Iter F.

/// Marker trait for future mesh implementations.
pub trait Mesh {
    // TODO: Iter F defines mesh runtime behavior.
}

#[cfg(test)]
mod tests {
    use super::Mesh;

    struct NoopMesh;

    impl Mesh for NoopMesh {}

    #[test]
    fn mesh_trait_accepts_implementors() {
        fn assert_mesh<T: Mesh>() {}

        assert_mesh::<NoopMesh>();
    }
}
