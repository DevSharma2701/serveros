import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { OrderStatusBadge, orderTypeLabel, PaymentStatusBadge } from '../../components/order-bits';
import { Badge, Card, ErrorState, KeyValue, Loading, NoAccess, Notice, ScreenScroll, SectionTitle } from '../../components/ui';
import { ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money, titleCase } from '../../lib/format';
import { useOrder } from '../../lib/queries';
import { colors, space } from '../../theme';

/** Read-only order details: items, bill, payments and history. Also the target of serveos://orders/<id>. */
export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { outlet, can } = useAuth();
  const allowed = can('order.view');
  const query = useOrder(id, allowed);
  const order = query.data;
  const tz = outlet?.timezone;
  const notFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <ScreenScroll testID="order-detail" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      <Stack.Screen options={{ title: order ? `Order #${order.orderNumber}` : 'Order' }} />
      {!allowed ? (
        <NoAccess feature="orders" />
      ) : query.isPending ? (
        <Loading label="Loading order" />
      ) : query.isError && !order ? (
        <>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="this order" />
          {notFound ? <Text style={styles.hint}>Orders belong to one outlet. You are looking at {outlet?.name}; if this order is from another outlet, switch outlet and open it again.</Text> : null}
        </>
      ) : order ? (
        <>
          {query.isError ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
          <Card>
            <View style={styles.badges}>
              <OrderStatusBadge status={order.status} />
              <PaymentStatusBadge status={order.paymentStatus} />
              {order.isHeld ? <Badge label="On hold" tone="warn" /> : null}
            </View>
            <KeyValue label="Type" value={orderTypeLabel(order.type)} />
            {order.tableLabel ? <KeyValue label="Table" value={order.tableLabel} /> : null}
            <KeyValue label="Guests" value={String(order.guestCount)} />
            {order.customer ? <KeyValue label="Customer" value={order.customer.name} /> : null}
            <KeyValue label="Created" value={dateTime(order.createdAt, tz)} />
            {order.placedAt ? <KeyValue label="Sent to kitchen" value={dateTime(order.placedAt, tz)} /> : null}
            {order.completedAt ? <KeyValue label="Completed" value={dateTime(order.completedAt, tz)} /> : null}
            {order.invoice ? <KeyValue label="Invoice" value={order.invoice.invoiceNumber} /> : null}
            {order.deliveryAddress ? <KeyValue label="Deliver to" value={[order.deliveryName, order.deliveryAddress].filter(Boolean).join(', ')} /> : null}
            {order.notes ? <KeyValue label="Notes" value={order.notes} /> : null}
            {order.cancelReason ? <KeyValue label="Cancel reason" value={order.cancelReason} tone="bad" /> : null}
          </Card>

          <Card>
            <SectionTitle>Items</SectionTitle>
            {order.items.map((item) => {
              const voided = item.status === 'VOIDED';
              return (
                <View key={item.id} style={styles.item} accessible accessibilityLabel={`${item.quantity} ${item.productName}${voided ? ', voided' : ''}, ${money(item.lineSubtotalMinor, order.currency)}`}>
                  <View style={styles.itemHead}>
                    <Text style={[styles.itemName, voided && styles.voided]}>
                      {item.quantity} × {item.productName}
                      {item.variantName && item.variantName !== 'Regular' ? ` (${item.variantName})` : ''}
                    </Text>
                    <Text style={[styles.itemAmount, voided && styles.voided]}>{money(item.lineSubtotalMinor, order.currency)}</Text>
                  </View>
                  {item.modifiers.map((m) => (
                    <Text key={m.id} style={styles.itemSub}>
                      {m.groupName}: {m.optionName}
                      {m.priceMinor ? ` (+${money(m.priceMinor, order.currency)})` : ''}
                    </Text>
                  ))}
                  {item.notes ? <Text style={styles.itemSub}>Note: {item.notes}</Text> : null}
                  {voided ? <Text style={[styles.itemSub, { color: colors.bad }]}>Voided{item.voidReason ? `: ${item.voidReason}` : ''}</Text> : null}
                </View>
              );
            })}
          </Card>

          <Card>
            <SectionTitle>Bill</SectionTitle>
            <KeyValue label="Subtotal" value={money(order.subtotalMinor, order.currency)} />
            {order.itemDiscountMinor + order.orderDiscountMinor > 0 ? <KeyValue label="Discounts" value={`-${money(order.itemDiscountMinor + order.orderDiscountMinor, order.currency)}`} /> : null}
            {order.serviceChargeMinor ? <KeyValue label="Service charge" value={money(order.serviceChargeMinor, order.currency)} /> : null}
            {order.deliveryChargeMinor ? <KeyValue label="Delivery charge" value={money(order.deliveryChargeMinor, order.currency)} /> : null}
            <KeyValue label="Tax" value={money(order.taxMinor, order.currency)} />
            {order.roundOffMinor ? <KeyValue label="Round-off" value={money(order.roundOffMinor, order.currency)} /> : null}
            <KeyValue label="Total" value={money(order.totalMinor, order.currency)} strong />
            <KeyValue label="Paid" value={money(order.paidMinor, order.currency)} />
            {order.refundedMinor ? <KeyValue label="Refunded" value={money(order.refundedMinor, order.currency)} tone="bad" /> : null}
          </Card>

          <Card>
            <SectionTitle>Payments</SectionTitle>
            {(order.payments ?? []).length === 0 ? <Text style={styles.itemSub}>No payments recorded.</Text> : null}
            {(order.payments ?? []).map((p) => (
              <KeyValue
                key={p.id}
                label={`${p.method === 'UPI' ? 'UPI' : titleCase(p.method)} · ${titleCase(p.state)} · ${dateTime(p.createdAt, tz)}`}
                value={money(p.amountMinor, order.currency)}
                tone={p.state === 'SUCCEEDED' ? undefined : 'warn'}
              />
            ))}
          </Card>

          <Card>
            <SectionTitle>History</SectionTitle>
            {(order.events ?? []).length === 0 ? <Text style={styles.itemSub}>No history recorded.</Text> : null}
            {(order.events ?? []).map((e) => (
              <View key={e.id} style={styles.event}>
                <Text style={styles.eventTitle}>{e.toStatus && e.fromStatus !== e.toStatus ? `${titleCase(e.type)} → ${titleCase(e.toStatus)}` : titleCase(e.type)}</Text>
                {e.message ? <Text style={styles.itemSub}>{e.message}</Text> : null}
                <Text style={styles.eventMeta}>
                  {dateTime(e.createdAt, tz)}
                  {e.actorName ? ` · ${e.actorName}` : ''}
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  item: { gap: 2, paddingVertical: space.xs },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  itemName: { flex: 1, fontSize: 15, color: colors.ink, fontWeight: '500' },
  itemAmount: { fontSize: 15, color: colors.ink, fontVariant: ['tabular-nums'] },
  itemSub: { fontSize: 13, color: colors.inkSoft },
  voided: { textDecorationLine: 'line-through', color: colors.inkFaint },
  event: { gap: 2, paddingVertical: space.xs, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: space.md },
  eventTitle: { fontSize: 14, fontWeight: '600', color: colors.ink },
  eventMeta: { fontSize: 12, color: colors.inkFaint },
  hint: { fontSize: 13, color: colors.inkSoft, textAlign: 'center', paddingHorizontal: space.lg },
});
