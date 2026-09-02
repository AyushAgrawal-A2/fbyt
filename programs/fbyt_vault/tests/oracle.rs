mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn feed_arg(feed: &str) -> Vec<u8> {
    let feed_bytes = feed.as_bytes();
    let mut encoded = (feed_bytes.len() as u32).to_le_bytes().to_vec(); // borsh String len prefix
    encoded.extend_from_slice(feed_bytes);
    encoded
}

#[test]
fn oracle_full_lifecycle_and_auth() {
    let mut env = boot();
    let admin_pool = inject_admin_pool(&mut env);
    let mint = inject_mint(&mut env, 6);
    let (oracle_pool, _) = oracle_pool_pda(admin_pool, mint);
    let admin = env.admin.insecure_clone();

    // CREATE (permissionless requester)
    let requester = Keypair::new();
    env.svm
        .airdrop(&requester.pubkey(), 10_000_000_000)
        .unwrap();
    let create_metas = vec![
        meta(requester.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
        meta(SYSTEM, false, false),
    ];
    send(
        &mut env,
        build_instruction(
            ix_disc("create_oracle_pool"),
            feed_arg("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
            create_metas,
        ),
        &[&requester],
    )
    .expect("create ok");
    assert!(!oracle_is_approved(&env, oracle_pool), "starts unapproved");

    // APPROVE — negative: wrong admin (has_one = admin)
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_metas = vec![
        meta(attacker.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
    ];
    let error = send(
        &mut env,
        build_instruction(ix_disc("approve_oracle_pool"), vec![], attacker_metas),
        &[&attacker],
    )
    .unwrap_err();
    assert!(
        error.contains("2001") || error.contains("HasOne") || error.contains("admin"),
        "expected has_one=admin, got: {error}"
    );
    assert!(
        !oracle_is_approved(&env, oracle_pool),
        "still unapproved after failed attempt"
    );

    // APPROVE — positive
    let approve_metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("approve_oracle_pool"), vec![], approve_metas),
        &[&admin],
    )
    .expect("approve ok");
    assert!(oracle_is_approved(&env, oracle_pool), "approved");

    // UPDATE — positive changes feed_id
    let new_feed = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let update_metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
    ];
    send(
        &mut env,
        build_instruction(
            ix_disc("update_oracle_pool"),
            feed_arg(new_feed),
            update_metas.clone(),
        ),
        &[&admin],
    )
    .expect("update ok");
    assert_eq!(
        &oracle_feed_id(&env, oracle_pool)[..new_feed.len()],
        new_feed.as_bytes()
    );

    // UPDATE — negative: feed_id > 66 bytes -> InvalidPriceFeed
    let long_feed = "x".repeat(67);
    let error = send(
        &mut env,
        build_instruction(
            ix_disc("update_oracle_pool"),
            feed_arg(&long_feed),
            update_metas,
        ),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        error.contains("InvalidPriceFeed"),
        "expected InvalidPriceFeed, got: {error}"
    );

    // CLOSE — positive: account removed, rent to admin
    let close_metas = vec![
        meta(admin.pubkey(), true, true),
        meta(admin_pool, false, true),
        meta(mint, false, true),
        meta(oracle_pool, false, true),
    ];
    send(
        &mut env,
        build_instruction(ix_disc("close_oracle_pool"), vec![], close_metas),
        &[&admin],
    )
    .expect("close ok");
    assert!(
        env.svm
            .get_account(&oracle_pool)
            .map(|account| account.data.is_empty() || account.owner == SYSTEM)
            .unwrap_or(true),
        "oracle_pool closed"
    );
}
