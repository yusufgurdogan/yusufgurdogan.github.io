import {Component, OnDestroy, OnInit} from '@angular/core';
import {ActivatedRoute, ChildActivationEnd, Router} from "@angular/router";
import {AddressBookService} from "../../services/address-book.service";
import {ApiService} from "../../services/api.service";
import {NotificationService} from "../../services/notification.service";
import {WalletService} from "../../services/wallet.service";
import {NanoBlockService} from "../../services/nano-block.service";
import {AppSettingsService} from "../../services/app-settings.service";
import {PriceService} from "../../services/price.service";
import {UtilService} from "../../services/util.service";
import * as QRCode from 'qrcode';
import BigNumber from "bignumber.js";
import {RepresentativeService} from "../../services/representative.service";
import {BehaviorSubject} from "rxjs";
import * as nanocurrency from 'nanocurrency'

@Component({
  selector: 'app-account-details',
  templateUrl: './account-details.component.html',
  styleUrls: ['./account-details.component.css']
})
export class AccountDetailsComponent implements OnInit, OnDestroy {
  nano = 1000000000000000000000000;

  accountHistory: any[] = [];
  pendingBlocks = [];
  pageSize = 25;
  maxPageSize = 200;

  repLabel: any = '';
  addressBookEntry: any = null;
  account: any = {};
  accountID: string = '';

  walletAccount = null;

  showEditAddressBook = false;
  addressBookModel = '';
  showEditRepresentative = false;
  representativeModel = '';
  representativeResults$ = new BehaviorSubject([]);
  showRepresentatives = false;
  representativeListMatch = '';
  isNaN = isNaN;

  qrCodeImage = null;

  routerSub = null;
  priceSub = null;

  statsRefreshEnabled = true;

  // Remote signing
  accounts = this.wallet.wallet.accounts;
  addressBookResults$ = new BehaviorSubject([]);
  showAddressBook = false;
  addressBookMatch = '';
  amounts = [
    { name: 'NANO (1 Mnano)', shortName: 'NANO', value: 'mnano' },
    { name: 'knano (0.001 Mnano)', shortName: 'knano', value: 'knano' },
    { name: 'nano (0.000001 Mnano)', shortName: 'nano', value: 'nano' },
  ];
  selectedAmount = this.amounts[0];

  amount = null;
  amountRaw: BigNumber = new BigNumber(0);
  amountFiat: number|null = null;
  rawAmount: BigNumber = new BigNumber(0);
  fromAccount: any = {};
  toAccount: any = false;
  toAccountID: string = '';
  toAddressBook = '';
  toAccountStatus = null;
  qrCodeImageBlock = null;
  blockHash = null;
  remoteVisible = false;
  // End remote signing

  constructor(
    private router: ActivatedRoute,
    private route: Router,
    private addressBook: AddressBookService,
    private api: ApiService,
    private price: PriceService,
    private repService: RepresentativeService,
    private notifications: NotificationService,
    private wallet: WalletService,
    private util: UtilService,
    public settings: AppSettingsService,
    private nanoBlock: NanoBlockService) { }

  async ngOnInit() {
    this.routerSub = this.route.events.subscribe(event => {
      if (event instanceof ChildActivationEnd) {
        this.loadAccountDetails(); // Reload the state when navigating to itself from the transactions page
      }
    });
    this.priceSub = this.price.lastPrice$.subscribe(event => {
      this.account.balanceFiat = this.util.nano.rawToMnano(this.account.balance || 0).times(this.price.price.lastPrice).toNumber();
      this.account.pendingFiat = this.util.nano.rawToMnano(this.account.pending || 0).times(this.price.price.lastPrice).toNumber();
    });

    await this.loadAccountDetails();
    this.addressBook.loadAddressBook();
  }

  async loadAccountDetails(refresh=false) {
    if (refresh && !this.statsRefreshEnabled) return
    this.statsRefreshEnabled = false;
    setTimeout(() => this.statsRefreshEnabled = true, 5000);

    this.pendingBlocks = [];
    this.accountID = this.router.snapshot.params.account;
    this.addressBookEntry = this.addressBook.getAccountName(this.accountID);
    this.addressBookModel = this.addressBookEntry || '';
    this.walletAccount = this.wallet.getWalletAccount(this.accountID);
    this.account = await this.api.accountInfo(this.accountID);

    const knownRepresentative = this.repService.getRepresentative(this.account.representative);
    this.repLabel = knownRepresentative ? knownRepresentative.name : null;

    // If there is a pending balance, or the account is not opened yet, load pending transactions
    if ((!this.account.error && this.account.pending > 0) || this.account.error) {
      // Take minimum receive into account
      let pending;
      if (this.settings.settings.minimumReceive) {
        const minAmount = this.util.nano.mnanoToRaw(this.settings.settings.minimumReceive);
        pending = await this.api.pendingLimit(this.accountID, 50, minAmount.toString(10));
      } else {
        pending = await this.api.pending(this.accountID, 50);
      }

      if (pending && pending.blocks) {
        for (let block in pending.blocks) {
          if (!pending.blocks.hasOwnProperty(block)) continue;
          this.pendingBlocks.push({
            account: pending.blocks[block].source,
            amount: pending.blocks[block].amount,
            local_timestamp: pending.blocks[block].local_timestamp,
            addressBookName: this.addressBook.getAccountName(pending.blocks[block].source) || null,
            hash: block,
          });
        }
      }
    }

    // If the account doesnt exist, set the pending balance manually
    if (this.account.error) {
      const pendingRaw = this.pendingBlocks.reduce((prev: BigNumber, current: any) => prev.plus(new BigNumber(current.amount)), new BigNumber(0));
      this.account.pending = pendingRaw;
    }

    // Set fiat values?
    this.account.balanceRaw = new BigNumber(this.account.balance || 0).mod(this.nano);
    this.account.pendingRaw = new BigNumber(this.account.pending || 0).mod(this.nano);
    this.account.balanceFiat = this.util.nano.rawToMnano(this.account.balance || 0).times(this.price.price.lastPrice).toNumber();
    this.account.pendingFiat = this.util.nano.rawToMnano(this.account.pending || 0).times(this.price.price.lastPrice).toNumber();
    await this.getAccountHistory(this.accountID);


    const qrCode = await QRCode.toDataURL(`${this.accountID}`);
    this.qrCodeImage = qrCode;
  }

  ngOnDestroy() {
    if (this.routerSub) {
      this.routerSub.unsubscribe();
    }
    if (this.priceSub) {
      this.priceSub.unsubscribe();
    }
  }

  async getAccountHistory(account, resetPage = true) {
    if (resetPage) {
      this.pageSize = 25;
    }
    const history = await this.api.accountHistory(account, this.pageSize, true);
    let additionalBlocksInfo = [];

    if (history && history.history && Array.isArray(history.history)) {
      this.accountHistory = history.history.map(h => {
        if (h.type === 'state') {
          // For Open and receive blocks, we need to look up block info to get originating account
          if (h.subtype === 'open' || h.subtype === 'receive') {
            additionalBlocksInfo.push({ hash: h.hash, link: h.link });
          } else {
            h.link_as_account = this.util.account.getPublicAccountID(this.util.hex.toUint8(h.link));
            h.addressBookName = this.addressBook.getAccountName(h.link_as_account) || null;
          }
        } else {
          h.addressBookName = this.addressBook.getAccountName(h.account) || null;
        }
        return h;
      });

      // Remove change blocks now that we are using the raw output
      this.accountHistory = this.accountHistory.filter(h => h.type !== 'change' && h.subtype !== 'change');

      if (additionalBlocksInfo.length) {
        const blocksInfo = await this.api.blocksInfo(additionalBlocksInfo.map(b => b.link));
        for (let block in blocksInfo.blocks) {
          if (!blocksInfo.blocks.hasOwnProperty(block)) continue;

          const matchingBlock = additionalBlocksInfo.find(a => a.link === block);
          if (!matchingBlock) continue;
          const accountInHistory = this.accountHistory.find(h => h.hash === matchingBlock.hash);
          if (!accountInHistory) continue;

          const blockData = blocksInfo.blocks[block];

          accountInHistory.link_as_account = blockData.block_account;
          accountInHistory.addressBookName = this.addressBook.getAccountName(blockData.block_account) || null;
        }
      }

    } else {
      this.accountHistory = [];
    }
  }

  async loadMore() {
    if (this.pageSize <= this.maxPageSize) {
      this.pageSize += 25;
      await this.getAccountHistory(this.accountID, false);
    }
  }

  async saveRepresentative() {
    if (this.wallet.walletIsLocked()) return this.notifications.sendWarning(`Wallet must be unlocked`);
    if (!this.walletAccount) return;
    const repAccount = this.representativeModel;

    const valid = await this.api.validateAccountNumber(repAccount);
    if (!valid || valid.valid !== '1') return this.notifications.sendWarning(`Account ID is not a valid account`);

    try {
      const changed = await this.nanoBlock.generateChange(this.walletAccount, repAccount, this.wallet.isLedgerWallet());
      if (!changed) {
        this.notifications.sendError(`Error changing representative, please try again`);
        return;
      }
    } catch (err) {
      this.notifications.sendError(err.message);
      return;
    }

    // Reload some states, we are successful
    this.representativeModel = '';
    this.showEditRepresentative = false;

    const accountInfo = await this.api.accountInfo(this.accountID);
    this.account = accountInfo;
    const newRep = this.repService.getRepresentative(repAccount);
    this.repLabel = newRep ? newRep.name : '';

    this.notifications.sendSuccess(`Successfully changed representative`);
  }

  async saveAddressBook() {
    const addressBookName = this.addressBookModel.trim();
    if (!addressBookName) {
      // Check for deleting an entry in the address book
      if (this.addressBookEntry) {
        this.addressBook.deleteAddress(this.accountID);
        this.notifications.sendSuccess(`Successfully removed address book entry!`);
        this.addressBookEntry = null;
      }

      this.showEditAddressBook = false;
      return;
    }

    try {
      await this.addressBook.saveAddress(this.accountID, addressBookName);
    } catch (err) {
      this.notifications.sendError(err.message);
      return;
    }

    this.notifications.sendSuccess(`Saved address book entry!`);

    this.addressBookEntry = addressBookName;
    this.showEditAddressBook = false;
  }

  searchRepresentatives() {
    this.showRepresentatives = true;
    const search = this.representativeModel || '';
    const representatives = this.repService.getSortedRepresentatives();

    const matches = representatives
      .filter(a => a.name.toLowerCase().indexOf(search.toLowerCase()) !== -1)
      .slice(0, 5);

    this.representativeResults$.next(matches);
  }

  selectRepresentative(rep) {
    this.showRepresentatives = false;
    this.representativeModel = rep;
    this.searchRepresentatives();
    this.validateRepresentative();
  }

  validateRepresentative() {
    setTimeout(() => this.showRepresentatives = false, 400);
    this.representativeModel = this.representativeModel.replace(/ /g, '');
    const rep = this.repService.getRepresentative(this.representativeModel);

    if (rep) {
      this.representativeListMatch = rep.name;
    } else {
      this.representativeListMatch = '';
    }
  }

  copied() {
    this.notifications.sendSuccess(`Successfully copied to clipboard!`);
  }

  // Remote signing methods
  // An update to the Nano amount, sync the fiat value
  syncFiatPrice() {
    const rawAmount = this.getAmountBaseValue(this.amount || 0).plus(this.amountRaw);
    if (rawAmount.lte(0)) {
      this.amountFiat = 0;
      return;
    }

    // This is getting hacky, but if their currency is bitcoin, use 6 decimals, if it is not, use 2
    const precision = this.settings.settings.displayCurrency === 'BTC' ? 1000000 : 100;

    // Determine fiat value of the amount
    const fiatAmount = this.util.nano.rawToMnano(rawAmount).times(this.price.price.lastPrice).times(precision).floor().div(precision).toNumber();
    this.amountFiat = fiatAmount;
  }

  // An update to the fiat amount, sync the nano value based on currently selected denomination
  syncNanoPrice() {
    const fiatAmount = this.amountFiat || 0;
    const rawAmount = this.util.nano.mnanoToRaw(new BigNumber(fiatAmount).div(this.price.price.lastPrice));
    const nanoVal = this.util.nano.rawToNano(rawAmount).floor();
    const nanoAmount = this.getAmountValueFromBase(this.util.nano.nanoToRaw(nanoVal));

    this.amount = nanoAmount.toNumber();
  }

  searchAddressBook() {
    this.showAddressBook = true;
    const search = this.toAccountID || '';
    const addressBook = this.addressBook.addressBook;

    const matches = addressBook
      .filter(a => a.name.toLowerCase().indexOf(search.toLowerCase()) !== -1)
      .slice(0, 5);

    this.addressBookResults$.next(matches);
  }

  selectBookEntry(account) {
    this.showAddressBook = false;
    this.toAccountID = account;
    this.searchAddressBook();
    this.validateDestination();
  }

  async validateDestination() {
    // The timeout is used to solve a bug where the results get hidden too fast and the click is never registered
    setTimeout(() => this.showAddressBook = false, 400);

    // Remove spaces from the account id
    this.toAccountID = this.toAccountID.replace(/ /g, '');

    this.addressBookMatch = this.addressBook.getAccountName(this.toAccountID);

    // const accountInfo = await this.walletService.walletApi.accountInfo(this.toAccountID);
    const accountInfo = await this.api.accountInfo(this.toAccountID);
    if (accountInfo.error) {
      if (accountInfo.error == 'Account not found') {
        this.toAccountStatus = 1;
      } else {
        this.toAccountStatus = 0;
      }
    }
    if (accountInfo && accountInfo.frontier) {
      this.toAccountStatus = 2;
    }
  }

  setMaxAmount() {
    this.amountRaw = this.account.balance ? this.account.balance:'0';
    const nanoVal = this.util.nano.rawToNano(this.amountRaw ).floor();
    const maxAmount = this.getAmountValueFromBase(this.util.nano.nanoToRaw(nanoVal));
    this.amount = maxAmount.toNumber();
    this.syncFiatPrice();
  }

  getAmountBaseValue(value) {

    switch (this.selectedAmount.value) {
      default:
      case 'nano': return this.util.nano.nanoToRaw(value);
      case 'knano': return this.util.nano.knanoToRaw(value);
      case 'mnano': return this.util.nano.mnanoToRaw(value);
    }
  }

  getAmountValueFromBase(value) {
    switch (this.selectedAmount.value) {
      default:
      case 'nano': return this.util.nano.rawToNano(value);
      case 'knano': return this.util.nano.rawToKnano(value);
      case 'mnano': return this.util.nano.rawToMnano(value);
    }
  }

  async generateSend() {
    const isValid = await this.api.validateAccountNumber(this.toAccountID);
    if (!isValid || isValid.valid == '0') return this.notifications.sendWarning(`To account address is not valid`);
    if (!this.accountID || !this.toAccountID) return this.notifications.sendWarning(`From and to account are required`);

    const from = await this.api.accountInfo(this.accountID);
    const to = await this.api.accountInfo(this.toAccountID);
    if (!from) return this.notifications.sendError(`From account not found`);

    from.balanceBN = new BigNumber(from.balance || 0);
    to.balanceBN = new BigNumber(to.balance || 0);

    this.fromAccount = from;
    this.toAccount = to;

    const rawAmount = this.getAmountBaseValue(this.amount || 0);
    this.rawAmount = rawAmount.plus(this.amountRaw);

    const nanoAmount = this.rawAmount.div(this.nano);

    if (this.amount < 0 || rawAmount.lessThan(0)) return this.notifications.sendWarning(`Amount is invalid`);
    if (nanoAmount.lessThan(1)) return this.notifications.sendWarning(`Transactions for less than 1 nano will be ignored by the node.  Send raw amounts with at least 1 nano.`);
    if (from.balanceBN.minus(rawAmount).lessThan(0)) return this.notifications.sendError(`From account does not have enough NANO`);

    // Determine a proper raw amount to show in the UI, if a decimal was entered
    this.amountRaw = this.rawAmount.mod(this.nano);

    // Determine fiat value of the amount
    this.amountFiat = this.util.nano.rawToMnano(rawAmount).times(this.price.price.lastPrice).toNumber();

    const remaining = new BigNumber(from.balance).minus(rawAmount);
    const remainingDecimal = remaining.toString(10);

    const representative = from.representative || (this.settings.settings.defaultRepresentative || this.nanoBlock.getRandomRepresentative());
    let blockData = {
      account: this.accountID,
      previous: from.frontier,
      representative: representative,
      balance: remainingDecimal,
      link: this.util.account.getAccountPublicKey(this.toAccountID),
    };
    this.blockHash = nanocurrency.hashBlock({account:blockData.account, link:blockData.link, previous:blockData.previous, representative: blockData.representative, balance: blockData.balance})
    console.log("Created block",blockData);
    console.log("Block hash: " + this.blockHash);

    // Previous block info
    const previousBlockInfo = await this.api.blockInfo(blockData.previous);
    if (!('contents' in previousBlockInfo)) return this.notifications.sendError(`Previous block not found`);
    const jsonBlock = JSON.parse(previousBlockInfo.contents)
    let blockDataPrevious = {
      account: jsonBlock.account,
      previous: jsonBlock.previous,
      representative: jsonBlock.representative,
      balance: jsonBlock.balance,
      link: jsonBlock.link,
    };

    // Nano signing standard (invented with feedback from the nano foundation)
    let qrString = 'nanosign:{"block":' + JSON.stringify(blockData) + ',"previous":' + JSON.stringify(blockDataPrevious) + '}'

    const qrCode = await QRCode.toDataURL(qrString, { errorCorrectionLevel: 'M', scale: 8 });
    this.qrCodeImageBlock = qrCode;
  }

  showRemote(state:boolean) {
    this.remoteVisible = !state;
  }

  // End remote signing methods

}
