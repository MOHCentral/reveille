// SPDX-License-Identifier: GPL-3.0-only

//! Explicitly opt-in catalogue smoke check; default and CI runs never open a socket.

use std::time::Duration;

use reveille_core::content::{CatalogueQuery, MohDbClient};

#[tokio::test]
#[ignore = "requires the live third-party moh-db catalogue"]
async fn live_catalogue_smoke_check_skips_when_unavailable() {
    let Ok(client) = MohDbClient::new(Duration::from_secs(15)) else {
        return;
    };
    let Ok(page) = client.lookup("obj/obj_howitzer").await else {
        return;
    };
    assert!(page.total_elements >= 1);
    assert!(
        page.content
            .iter()
            .any(|candidate| candidate.map_key.as_str() == "obj/obj_howitzer")
    );
}

#[tokio::test]
#[ignore = "requires the live third-party moh-db catalogue"]
async fn live_browse_returns_a_page_of_titled_maps_without_an_api_key() {
    let Ok(client) = MohDbClient::new(Duration::from_secs(15)) else {
        return;
    };
    let page = client
        .browse(&CatalogueQuery::default())
        .await
        .expect("moh-db answers a browse request without an X-API-Key header");
    assert!(page.total_elements > 0);
    assert!(!page.entries.is_empty());
    assert!(page.entries.iter().all(|entry| !entry.title.is_empty()));
    assert!(page.entries.iter().any(|entry| entry.candidate.is_some()));
}
