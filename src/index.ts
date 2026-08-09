import type { ProviderDefinition } from '@vault-flow/provider-api';
import { XBookmarksProvider } from './provider';

const createXBookmarksProvider: ProviderDefinition = () => new XBookmarksProvider();

export default createXBookmarksProvider;
