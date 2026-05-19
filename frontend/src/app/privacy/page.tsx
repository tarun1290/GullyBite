import type { Metadata } from 'next';
import LegalDocLayout, {
  LegalIntro,
  LegalSection,
  LegalSubsection,
  LegalParagraph,
  LegalList,
  LegalClauseList,
} from '@/components/shared/LegalDocLayout';
import { PRIVACY_VERSION, LEGAL_LAST_UPDATED } from '@/lib/constants/legal';

export const metadata: Metadata = {
  title: 'Privacy Policy — GullyBite',
  description:
    'How Doteye Labs collects, uses, stores, and shares personal data on the GullyBite platform — including data retention, your DPDP Act rights, and dispute resolution.',
};

export default function PrivacyPage() {
  return (
    <LegalDocLayout
      title="Privacy Policy — GullyBite"
      lastUpdated={LEGAL_LAST_UPDATED}
      version={PRIVACY_VERSION}
    >
      <LegalIntro>
        <p>
          This Privacy Policy describes how Doteye Labs (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;, &ldquo;our&rdquo;) collects, uses, stores, and
          shares personal data when you (&ldquo;Restaurant&rdquo;,
          &ldquo;Customer&rdquo;, &ldquo;you&rdquo;) interact with the
          GullyBite platform (&ldquo;Platform&rdquo;).
        </p>
      </LegalIntro>

      <LegalSection heading="1. Who We Are">
        <LegalParagraph>
          Doteye Labs is the data controller for personal data collected
          through the Platform. Registered office: India. Contact:
          outreach@doteyelabs.com.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="2. Who This Policy Applies To">
        <LegalParagraph>
          This policy applies to two categories of users:
        </LegalParagraph>
        <LegalClauseList
          items={[
            {
              label: '(a)',
              body: (
                <LegalParagraph>
                  Restaurants — businesses that sign up to use the Platform to
                  manage their operations
                </LegalParagraph>
              ),
            },
            {
              label: '(b)',
              body: (
                <LegalParagraph>
                  Customers — end-users who place food orders with restaurants
                  via WhatsApp through the Platform
                </LegalParagraph>
              ),
            },
          ]}
        />
      </LegalSection>

      <LegalSection heading="3. Personal Data We Collect">
        <LegalSubsection heading="From Restaurants">
          <LegalList
            items={[
              'Identity: business name, owner/manager name, business email, phone number, profile picture',
              'Business identifiers: GST number, FSSAI license number, restaurant address, branch addresses',
              'Financial: bank account details (collected by Razorpay, not directly by us, for payout purposes)',
              'Account credentials: email and securely hashed password',
              "Meta identifiers: WhatsApp Business Account ID, phone number ID, Meta Business Portfolio ID, Meta Commerce catalog ID (obtained via Meta's Embedded Signup with your authorization)",
              'Usage data: dashboard activity logs, IP addresses, device information',
            ]}
          />
        </LegalSubsection>
        <LegalSubsection heading="From Customers (collected on behalf of the Restaurant they are ordering from)">
          <LegalList
            items={[
              'Contact: WhatsApp phone number, name (if shared)',
              'Delivery: address, locality, geocoordinates',
              'Order data: items ordered, order history with the specific restaurant',
              'Message history: WhatsApp message contents exchanged with the restaurant',
              'Payment data: UPI ID and payment metadata (collected and processed by Razorpay, not stored by us)',
            ]}
          />
        </LegalSubsection>
      </LegalSection>

      <LegalSection heading="4. How We Use Personal Data">
        <LegalSubsection heading="For Restaurants">
          <LegalList
            items={[
              'To provide and operate the Platform services',
              'To process subscription payments and send invoices',
              'To send service-related communications (notifications, account updates, support)',
              'To comply with legal obligations (GST, tax filings, fraud prevention)',
              'To improve and develop new features',
            ]}
          />
        </LegalSubsection>
        <LegalSubsection heading="For Customers">
          <LegalList
            items={[
              "To enable the Restaurant to receive, process, and fulfill the Customer's order",
              "To send the Customer transactional WhatsApp messages on the Restaurant's behalf (order confirmation, status updates, delivery tracking, payment receipts)",
              'To facilitate payment processing via Razorpay',
              'To enable the Restaurant to send marketing messages to Customers who have opted in',
              'To analyze aggregated usage trends to improve the Platform (non-identifying)',
            ]}
          />
        </LegalSubsection>
      </LegalSection>

      <LegalSection heading="5. Legal Basis for Processing (DPDP Act 2023)">
        <LegalParagraph>
          We process personal data on the following legal bases:
        </LegalParagraph>
        <LegalList
          items={[
            'Consent: where you have voluntarily provided data through signup, onboarding, or by initiating a WhatsApp conversation with a Restaurant',
            'Contractual necessity: to perform our service contract with the Restaurant',
            'Legal obligation: to comply with tax, financial, and consumer protection laws',
            'Legitimate interests: for fraud prevention, security, and Platform improvement (balanced against your rights)',
          ]}
        />
      </LegalSection>

      <LegalSection heading="6. How We Share Personal Data">
        <LegalParagraph>
          We share personal data with the following categories of recipients,
          only as necessary:
        </LegalParagraph>
        <LegalList
          items={[
            'Meta Platforms, Inc.: to deliver messages, render product catalogs, and operate WhatsApp Business and Commerce features',
            'Razorpay Software Private Limited: to process customer payments and remit settlements',
            'Amazon Web Services, Inc.: cloud infrastructure (servers, storage, caching)',
            'MongoDB, Inc.: managed database services',
            'Vercel Inc.: web application hosting',
            'Google LLC: address geocoding (Google Maps Platform), authentication (Google Sign-In)',
            "Delivery logistics partners (such as Prorouting Technologies Private Limited): customer phone, name, and delivery address are shared with the Restaurant's chosen logistics provider strictly for delivery fulfillment",
            'Legal authorities: where required by law, court order, or to protect our rights',
          ]}
        />
        <LegalParagraph>
          We do NOT sell personal data to third parties for advertising or any
          other purpose.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="7. Data Retention">
        <LegalList
          items={[
            'Restaurant account data: retained while your account is active, plus 7 years after termination for tax and legal compliance',
            'Customer order data: retained for 7 years from order date for tax compliance and dispute resolution',
            'WhatsApp message history: retained for 90 days from message date for support and audit purposes, after which it is anonymized or deleted',
            'Marketing opt-in data: retained until you withdraw consent',
          ]}
        />
      </LegalSection>

      <LegalSection heading="8. Your Rights">
        <LegalParagraph>
          Under India&apos;s DPDP Act 2023 and other applicable laws, you have
          the following rights regarding your personal data:
        </LegalParagraph>
        <LegalList
          items={[
            'Right to access: request a copy of personal data we hold about you',
            'Right to correction: request correction of inaccurate or incomplete data',
            'Right to erasure: request deletion of personal data where legal grounds permit',
            'Right to withdraw consent: withdraw consent previously given (which may limit your use of the Platform)',
            'Right to grievance redressal: lodge a complaint with our Data Protection Officer',
          ]}
        />
        <LegalParagraph>
          To exercise any of these rights, contact us at
          outreach@doteyelabs.com. We will respond within the timeframes
          required by applicable law (typically 30 days).
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="9. Customers' Rights to Stop WhatsApp Messages">
        <LegalParagraph>
          End Customers may stop receiving WhatsApp messages from a Restaurant
          at any time by:
        </LegalParagraph>
        <LegalList
          items={[
            "Sending \"STOP\" to the Restaurant's WhatsApp number to unsubscribe from marketing messages",
            "Blocking the Restaurant's WhatsApp number to stop all messages",
          ]}
        />
        <LegalParagraph>
          Transactional order messages (order confirmation, status updates)
          are sent based on the Customer&apos;s initiation of an order with
          the Restaurant.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="10. Data Security">
        <LegalParagraph>
          We implement industry-standard security measures including:
        </LegalParagraph>
        <LegalList
          items={[
            'TLS encryption for data in transit',
            'Encryption at rest for sensitive data',
            'Access controls and authentication',
            'Regular security audits and updates',
          ]}
        />
        <LegalParagraph>
          However, no system is fully secure, and we cannot guarantee absolute
          security. You are responsible for keeping your account credentials
          secure.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="11. International Data Transfers">
        <LegalParagraph>
          The Platform uses cloud infrastructure that may store and process
          data in data centers located outside India (primarily AWS Mumbai
          region for primary storage). Where data is transferred outside
          India, we ensure appropriate safeguards consistent with applicable
          law.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="12. Children">
        <LegalParagraph>
          The Platform is not intended for use by individuals under 18. We do
          not knowingly collect personal data from children. If you believe we
          have collected data from a child, contact us immediately for
          deletion.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="13. Changes to This Policy">
        <LegalParagraph>
          We may update this Privacy Policy from time to time. Material changes
          will be notified via dashboard banner or email at least 14 days
          before they take effect.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="14. Dispute Resolution; Arbitration">
        <LegalSubsection heading="14.1 Good-Faith Negotiation">
          <LegalParagraph>
            Before initiating any formal dispute resolution proceeding, the
            parties shall first attempt to resolve any dispute, controversy, or
            claim arising out of or relating to these Terms, the Platform, or
            the relationship between the parties (each, a &ldquo;Dispute&rdquo;)
            through good-faith negotiation between authorized representatives of
            the parties for a period of not less than thirty (30) days from the
            date one party gives written notice of the Dispute to the other.
          </LegalParagraph>
        </LegalSubsection>

        <LegalSubsection heading="14.2 Arbitration">
          <LegalParagraph>
            If the Dispute is not resolved within the thirty (30) day
            negotiation period, it shall be finally resolved by binding
            arbitration in accordance with the Arbitration and Conciliation
            Act, 1996 (and any amendments thereto), administered as follows:
          </LegalParagraph>
          <LegalClauseList
            items={[
              {
                label: '(a)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">
                      Number of Arbitrators:
                    </span>{' '}
                    The arbitration shall be conducted by a sole arbitrator
                    mutually appointed by the parties. If the parties cannot
                    agree on an arbitrator within fifteen (15) days of the
                    arbitration being invoked, the arbitrator shall be appointed
                    in accordance with Section 11 of the Arbitration and
                    Conciliation Act, 1996.
                  </LegalParagraph>
                ),
              },
              {
                label: '(b)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">
                      Seat and Venue of Arbitration:
                    </span>{' '}
                    The seat and venue of the arbitration shall be Srikakulam,
                    Andhra Pradesh, India. Both parties agree that the courts at
                    Srikakulam, Andhra Pradesh shall have exclusive supervisory
                    jurisdiction over the arbitration, including but not limited
                    to applications for interim relief, appointment of
                    arbitrators under Section 11, challenges to the arbitral
                    award under Section 34, and enforcement of the arbitral
                    award.
                  </LegalParagraph>
                ),
              },
              {
                label: '(c)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">Language:</span>{' '}
                    The arbitration proceedings shall be conducted in the
                    English language.
                  </LegalParagraph>
                ),
              },
              {
                label: '(d)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">
                      Confidentiality:
                    </span>{' '}
                    The arbitration proceedings, including the existence of the
                    Dispute, all submissions, evidence, transcripts, and the
                    award, shall be kept confidential by both parties, except as
                    required by applicable law or for enforcement of the award.
                  </LegalParagraph>
                ),
              },
              {
                label: '(e)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">Costs:</span> Each
                    party shall bear its own costs of arbitration, including
                    legal fees, unless the arbitrator orders otherwise in the
                    final award.
                  </LegalParagraph>
                ),
              },
              {
                label: '(f)',
                body: (
                  <LegalParagraph>
                    <span className="font-semibold text-tx">Finality:</span>{' '}
                    The arbitral award shall be final and binding on both
                    parties and may be enforced in any court of competent
                    jurisdiction.
                  </LegalParagraph>
                ),
              },
            ]}
          />
        </LegalSubsection>

        <LegalSubsection heading="14.3 Interim Relief">
          <LegalParagraph>
            Notwithstanding Section 14.2, either party may apply to the courts
            at Srikakulam, Andhra Pradesh for urgent interim or injunctive
            relief at any time, without first having to invoke or conclude
            arbitration, where necessary to protect its rights, prevent
            irreparable harm, or preserve the status quo pending arbitration.
          </LegalParagraph>
        </LegalSubsection>

        <LegalSubsection heading="14.4 Exclusion of Class Actions">
          <LegalParagraph>
            To the maximum extent permitted by law, all Disputes between the
            parties shall be conducted on an individual basis only. Neither
            party shall participate in a class, consolidated, or representative
            action against the other.
          </LegalParagraph>
        </LegalSubsection>
      </LegalSection>

      <LegalSection heading="15. Governing Law">
        <LegalParagraph>
          These Terms shall be governed by, construed, and enforced in
          accordance with the laws of the Republic of India, without regard to
          its conflict of laws principles. Subject to Section 14 (Dispute
          Resolution; Arbitration), the courts at Srikakulam, Andhra Pradesh
          shall have exclusive jurisdiction over all matters arising out of or
          relating to these Terms.
        </LegalParagraph>
      </LegalSection>

      <LegalParagraph>
        <span className="font-semibold text-tx">
          By using the GullyBite platform, you confirm that you have read and
          understood this Privacy Policy.
        </span>
      </LegalParagraph>
    </LegalDocLayout>
  );
}
