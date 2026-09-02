use anchor_lang::prelude::*;

#[error_code]
pub enum FbytError {
    #[msg("LOK")]
    LOK,
    #[msg("Not approved")]
    NotApproved,
    #[msg("Not support token_2022 mint extension")]
    NotSupportMint,
    #[msg("Missing tickarray bitmap extension account")]
    MissingTickArrayBitmapExtensionAccount,
    #[msg("Insufficient liquidity for this direction")]
    InsufficientLiquidityForDirection,
    #[msg("Max token overflow")]
    MaxTokenOverflow,
    #[msg("calculate overflow")]
    CalculateOverflow,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Zero Transfer")]
    ZeroTransfer,
    #[msg("Price Feed Error")]
    PriceFeedError,
    #[msg("Invalid fee configuration")]
    InvalidFeeConfiguration,
    #[msg("Invalid deposit amount")]
    InvalidDepositAmount,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("Vault not active")]
    VaultNotActive,
    #[msg("Max raise amount exceeded")]
    MaxRaiseAmountExceeded,
    #[msg("Min raise amount not reached")]
    MinRaiseAmountNotReached,
    #[msg("Outside raise period")]
    OutsideRaisePeriod,
    #[msg("Min raise period not met")]
    MinRaisePeriodNotMet,
    #[msg("Invalid raise amount")]
    InvalidRaiseAmount,
    #[msg("Invalid contribution amount")]
    InvalidContributionAmount,
    #[msg("Invalid max contribution")]
    InvalidMaxContribution,
    #[msg("Invalid raise period")]
    InvalidRaisePeriod,
    #[msg("Invalid vault pool")]
    InvalidVaultPool,
    #[msg("Invalid admin pool")]
    InvalidAdminPool,
    #[msg("Invalid investor pool")]
    InvalidInvestorPool,
    #[msg("Invalid investor")]
    InvalidInvestor,
    #[msg("Idle limit period exceeded")]
    IdleLimitPeriodExceeded,
    #[msg("Vault inactive")]
    VaultInActive,
    #[msg("Invalid from account")]
    InvalidFromAccount,
    #[msg("Invalid to account")]
    InvalidToAccount,
    #[msg("Invalid to account owner")]
    InvalidToAccountOwner,
    #[msg("Invalid from account owner")]
    InvalidFromAccountOwner,
    #[msg("Fund raise period not over")]
    FundRaisePeriodNotOver,
    #[msg("Invalid admin")]
    InvalidAdmin,
    #[msg("Invalid oracle pool")]
    InvalidOraclePool,
    #[msg("OUtsideWithdrawPeriod")]
    OutsideWithdrawPeriod,
    #[msg("Invalid account length")]
    InvalidAccountLength,
    #[msg("Invalid account data")]
    InvalidAccountData,
    #[msg("Invalid price oracle")]
    InvalidPriceOracle,
    #[msg("Invalid price feed")]
    InvalidPriceFeed,
    #[msg("Invalid trading period")]
    InvalidTradingPeriod,
    #[msg("Vault closed")]
    VaultClosed,
    #[msg("Withdraw amount exceeds limit")]
    WithdrawAmountExceedsLimit,
    #[msg("Invalid money manager account")]
    InvalidMoneyManagerAccount,
    #[msg("Invalid admin account")]
    InvalidAdminAccount,
    #[msg("Invalid money manager")]
    InvalidMoneyManager,
    #[msg("Overflow")]
    Overflow,
    #[msg("Invalid vault owner")]
    InvalidVaultOwner,
    #[msg("Invalid token owner")]
    InvalidTokenOwner,
    #[msg("Invalid token vault")]
    InvalidTokenVault,
    #[msg("Invalid withdraw cooldown")]
    InvalidWithdrawCooldown,
    #[msg("Invalid withdraw period")]
    InvalidWithdrawPeriod,
    #[msg("Withdraw cooldown not ended")]
    WithdrawCooldownNotEnded,
    #[msg("Vault is dormant")]
    VaultIsDormant,
    #[msg("Invalid operator")]
    InvalidOperator,
    #[msg("Outside operator withdraw period")]
    OutsideOperatorWithdrawPeriod,
    #[msg("Invalid asset registry")]
    InvalidAssetRegistry,
    #[msg("Asset not found")]
    AssetNotFound,
    #[msg("Invalid input balance")]
    InvalidInputBalance,
    #[msg("Invalid output balance")]
    InvalidOutputBalance,
    #[msg("Unexpected price exponent")]
    UnexpectedPriceExponent,
    #[msg("Oracle not approved")]
    OracleNotApproved,
    #[msg("Invalid fee")]
    InvalidFee,
    #[msg("Max asset count exceeded")]
    MaxAssetCountExceeded,
    #[msg("No trades yet")]
    NoTradesYet,
    #[msg("Invalid pending admin")]
    InvalidPendingAdmin,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Zero withdraw shares")]
    ZeroWithdrawShares,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Invalid bps")]
    InvalidBps,
    #[msg("Invalid trading delegate")]
    InvalidTradingDelegate,
    #[msg("Vault has no trading delegate")]
    NoTradingDelegate,
    #[msg("Signer is not authorized to trade this vault")]
    UnauthorizedTrader,
}
